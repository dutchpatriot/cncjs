import _ from 'lodash';
import * as parser from 'gcode-parser';
import SerialPort from 'serialport';
import EventTrigger from '../../lib/EventTrigger';
import Feeder from '../../lib/Feeder';
import Sender, { SP_TYPE_CHAR_COUNTING } from '../../lib/Sender';
import Workflow, {
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_PAUSED,
    WORKFLOW_STATE_RUNNING
} from '../../lib/Workflow';
import ensureArray from '../../lib/ensure-array';
import ensurePositiveNumber from '../../lib/ensure-positive-number';
import evaluateExpression from '../../lib/evaluateExpression';
import logger from '../../lib/logger';
import translateWithContext from '../../lib/translateWithContext';
import config from '../../services/configstore';
import monitor from '../../services/monitor';
import taskRunner from '../../services/taskrunner';
import store from '../../store';
import Smoothie from './Smoothie';
import {
    SMOOTHIE,
    SMOOTHIE_ACTIVE_STATE_HOLD,
    SMOOTHIE_REALTIME_COMMANDS
} from './constants';

// % commands
const WAIT = '%wait';

const log = logger('controller:Smoothie');
const noop = _.noop;

class SmoothieController {
    type = SMOOTHIE;

    // CNCEngine
    engine = null;

    // Connections
    connections = {};

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;
    serialportListener = {
        data: (data) => {
            log.silly(`< ${data}`);
            this.controller.parse('' + data);
        },
        disconnect: (err) => {
            this.ready = false;
            if (err) {
                log.warn(`Disconnected from serial port "${this.options.port}":`, err);
            }

            this.close(err => {
                // Remove controller from store
                const port = this.options.port;
                store.unset(`controllers[${JSON.stringify(port)}]`);

                // Destroy controller
                this.destroy();
            });
        },
        error: (err) => {
            this.ready = false;
            if (err) {
                log.error(`Unexpected error while reading/writing serial port "${this.options.port}":`, err);
            }
        }
    };

    // Smoothie
    controller = null;
    ready = false;
    state = {};
    settings = {};
    queryTimer = null;
    actionMask = {
        queryParserState: {
            state: false, // wait for a message containing the current G-code parser modal state
            reply: false // wait for an `ok` or `error` response
        },
        queryStatusReport: false,

        // Respond to user input
        replyParserState: false, // $G
        replyStatusReport: false // ?
    };
    actionTime = {
        queryParserState: 0,
        queryStatusReport: 0,
        senderFinishTime: 0
    };
    feedOverride = 100;
    spindleOverride = 100;

    // Event Trigger
    event = null;

    // Feeder
    feeder = null;

    // Sender
    sender = null;

    // Workflow
    workflow = null;

    constructor(engine, options) {
        if (!engine) {
            throw new Error('engine must be specified');
        }
        this.engine = engine;

        const { port, baudrate } = { ...options };
        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // Event Trigger
        this.event = new EventTrigger((event, trigger, commands) => {
            log.debug(`EventTrigger: event="${event}", trigger="${trigger}", commands="${commands}"`);
            if (trigger === 'system') {
                taskRunner.run(commands);
            } else {
                this.command(null, 'gcode', commands);
            }
        });

        // Feeder
        this.feeder = new Feeder({
            dataFilter: (line, context) => {
                context = this.populateContext(context);

                const data = parser.parseLine(line, { flatten: true });
                const words = ensureArray(data.words);

                if (line[0] === '%') {
                    // Remove characters after ";"
                    const re = new RegExp(/\s*;.*/g);
                    line = line.replace(re, '');

                    // %wait
                    if (line === WAIT) {
                        log.debug('Wait for the planner queue to empty');
                        return `G4 P0.5 (${WAIT})`; // dwell
                    }

                    // Expression
                    // %_x=posx,_y=posy,_z=posz
                    evaluateExpression(line.slice(1), context);
                    return '';
                }

                { // Program Mode: M0, M1, M2, M30
                    const programMode = _.intersection(words, ['M0', 'M1', 'M2', 'M30'])[0];
                    if (programMode === 'M0') {
                        log.debug('M0 Program Pause');
                        this.feeder.hold();
                        this.emit('message', { cmd: 'M0' });
                    } else if (programMode === 'M1') {
                        log.debug('M1 Program Pause');
                        this.feeder.hold();
                        this.emit('message', { cmd: 'M1' });
                    } else if (programMode === 'M2') {
                        log.debug('M2 Program End');
                        this.feeder.hold();
                        this.emit('message', { cmd: 'M2' });
                    } else if (programMode === 'M30') {
                        log.debug('M30 Program End');
                        this.feeder.hold();
                        this.emit('message', { cmd: 'M30' });
                    }
                }

                // M6 Tool Change
                if (words.includes('M6')) {
                    log.debug('M6 Tool Change');
                    this.feeder.hold();
                    this.emit('message', { cmd: 'M6' });
                }

                // line="G0 X[posx - 8] Y[ymax]"
                // > "G0 X2 Y50"
                return translateWithContext(line, context);
            }
        });
        this.feeder.on('data', (line = '', context = {}) => {
            if (this.isClose()) {
                log.error(`Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.controller.isAlarm()) {
                // Feeder
                this.feeder.clear();
                log.warn('Stopped sending G-code commands in Alarm mode');
                return;
            }

            line = String(line).trim();
            if (line.length === 0) {
                return;
            }

            this.emit('serialport:write', line + '\n', context);

            this.serialport.write(line + '\n');
            log.silly(`> ${line}`);
        });
        this.feeder.on('hold', noop);
        this.feeder.on('unhold', noop);

        // Sender
        this.sender = new Sender(SP_TYPE_CHAR_COUNTING, {
            // Deduct the buffer size to prevent from buffer overrun
            bufferSize: (128 - 8), // The default buffer size is 128 bytes
            dataFilter: (line, context) => {
                context = this.populateContext(context);

                const data = parser.parseLine(line, { flatten: true });
                const words = ensureArray(data.words);
                const { sent, received } = this.sender.state;

                if (line[0] === '%') {
                    // Remove characters after ";"
                    const re = new RegExp(/\s*;.*/g);
                    line = line.replace(re, '');

                    // %wait
                    if (line === WAIT) {
                        log.debug(`Wait for the planner queue to empty: line=${sent + 1}, sent=${sent}, received=${received}`);
                        this.sender.hold();
                        return `G4 P0.5 (${WAIT})`; // dwell
                    }

                    // Expression
                    // %_x=posx,_y=posy,_z=posz
                    evaluateExpression(line.slice(1), context);
                    return '';
                }

                { // Program Mode: M0, M1, M2, M30
                    const programMode = _.intersection(words, ['M0', 'M1', 'M2', 'M30'])[0];
                    if (programMode === 'M0') {
                        log.debug(`M0 Program Pause: line=${sent + 1}, sent=${sent}, received=${received}`);
                        this.workflow.pause({ err: null, data: 'M0' });
                    } else if (programMode === 'M1') {
                        log.debug(`M1 Program Pause: line=${sent + 1}, sent=${sent}, received=${received}`);
                        this.workflow.pause({ err: null, data: 'M1' });
                    } else if (programMode === 'M2') {
                        log.debug(`M2 Program End: line=${sent + 1}, sent=${sent}, received=${received}`);
                        this.workflow.pause({ err: null, data: 'M2' });
                    } else if (programMode === 'M30') {
                        log.debug(`M30 Program End: line=${sent + 1}, sent=${sent}, received=${received}`);
                        this.workflow.pause({ err: null, data: 'M30' });
                    }
                }

                // M6 Tool Change
                if (words.includes('M6')) {
                    log.debug(`M6 Tool Change: line=${sent + 1}, sent=${sent}, received=${received}`);
                    this.workflow.pause({ err: null, data: 'M6' });
                }

                // line="G0 X[posx - 8] Y[ymax]"
                // > "G0 X2 Y50"
                return translateWithContext(line, context);
            }
        });
        this.sender.on('data', (line = '', context = {}) => {
            if (this.isClose()) {
                log.error(`Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.workflow.state === WORKFLOW_STATE_IDLE) {
                log.error(`Unexpected workflow state: ${this.workflow.state}`);
                return;
            }

            line = String(line).trim();
            if (line.length === 0) {
                log.warn(`Expected non-empty line: N=${this.sender.state.sent}`);
                return;
            }

            this.serialport.write(line + '\n');
            log.silly(`> ${line}`);
        });
        this.sender.on('hold', noop);
        this.sender.on('unhold', noop);
        this.sender.on('start', (startTime) => {
            this.actionTime.senderFinishTime = 0;
        });
        this.sender.on('end', (finishTime) => {
            this.actionTime.senderFinishTime = finishTime;
        });

        // Workflow
        this.workflow = new Workflow();
        this.workflow.on('start', (context) => {
            this.emit('workflow:state', this.workflow.state, this.workflow.context);
            this.sender.rewind();
        });
        this.workflow.on('stop', (context) => {
            this.emit('workflow:state', this.workflow.state, this.workflow.context);
            this.sender.rewind();
        });
        this.workflow.on('pause', (context) => {
            this.emit('workflow:state', this.workflow.state, this.workflow.context);
            this.sender.hold();
        });
        this.workflow.on('resume', (context) => {
            this.emit('workflow:state', this.workflow.state, this.workflow.context);

            // Clear feeder queue prior to resume program execution
            this.feeder.clear();
            this.feeder.unhold();

            // Resume program execution
            this.sender.unhold();
            this.sender.next();
        });

        // Smoothie
        this.controller = new Smoothie();

        this.controller.on('raw', noop);

        this.controller.on('status', (res) => {
            this.actionMask.queryStatusReport = false;

            if (this.actionMask.replyStatusReport) {
                this.actionMask.replyStatusReport = false;
                this.emit('serialport:read', res.raw);
            }

            // Check if the receive buffer is available in the status report (#115)
            // @see https://github.com/cncjs/cncjs/issues/115
            // @see https://github.com/cncjs/cncjs/issues/133
            const rx = Number(_.get(res, 'buf.rx', 0)) || 0;
            if (rx > 0) {
                // Do not modify the buffer size when running a G-code program
                if (this.workflow.state !== WORKFLOW_STATE_IDLE) {
                    return;
                }

                // Check if the streaming protocol is character-counting streaming protocol
                if (this.sender.sp.type !== SP_TYPE_CHAR_COUNTING) {
                    return;
                }

                // Check if the queue is empty
                if (this.sender.sp.dataLength !== 0) {
                    return;
                }

                // Deduct the receive buffer length to prevent from buffer overrun
                const bufferSize = (rx - 8); // TODO
                if (bufferSize > this.sender.sp.bufferSize) {
                    this.sender.sp.bufferSize = bufferSize;
                }
            }
        });

        this.controller.on('ok', (res) => {
            if (this.actionMask.queryParserState.reply) {
                if (this.actionMask.replyParserState) {
                    this.actionMask.replyParserState = false;
                    this.emit('serialport:read', res.raw);
                }
                this.actionMask.queryParserState.reply = false;
                return;
            }

            const { hold, sent, received } = this.sender.state;

            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                this.sender.ack();
                if (hold && (received >= sent)) {
                    log.debug(`Continue sending G-code: hold=${hold}, sent=${sent}, received=${received}`);
                    this.sender.unhold();
                }
                this.sender.next();
                return;
            }

            if ((this.workflow.state === WORKFLOW_STATE_PAUSED) && (received < sent)) {
                if (!hold) {
                    log.error('The sender does not hold off during the paused state');
                }
                if (received + 1 >= sent) {
                    log.debug(`Stop sending G-code: hold=${hold}, sent=${sent}, received=${received + 1}`);
                }
                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emit('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.controller.on('error', (res) => {
            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                const { lines, received } = this.sender.state;
                const line = lines[received] || '';

                this.emit('serialport:read', `> ${line.trim()} (line=${received + 1})`);
                this.emit('serialport:read', res.raw);

                this.workflow.pause({ err: res.raw });

                this.sender.ack();
                this.sender.next();

                return;
            }

            this.emit('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.controller.on('alarm', (res) => {
            this.emit('serialport:read', res.raw);
        });

        this.controller.on('parserstate', (res) => {
            this.actionMask.queryParserState.state = false;
            this.actionMask.queryParserState.reply = true;

            if (this.actionMask.replyParserState) {
                this.emit('serialport:read', res.raw);
            }
        });

        this.controller.on('parameters', (res) => {
            this.emit('serialport:read', res.raw);
        });

        this.controller.on('version', (res) => {
            this.emit('serialport:read', res.raw);
        });

        this.controller.on('others', (res) => {
            this.emit('serialport:read', res.raw);
        });

        const queryStatusReport = () => {
            // Check the ready flag
            if (!(this.ready)) {
                return;
            }

            const now = new Date().getTime();

            // The status report query (?) is a realtime command, it does not consume the receive buffer.
            const lastQueryTime = this.actionTime.queryStatusReport;
            if (lastQueryTime > 0) {
                const timespan = Math.abs(now - lastQueryTime);
                const toleranceTime = 5000; // 5 seconds

                // Check if it has not been updated for a long time
                if (timespan >= toleranceTime) {
                    log.debug(`Continue status report query: timespan=${timespan}ms`);
                    this.actionMask.queryStatusReport = false;
                }
            }

            if (this.actionMask.queryStatusReport) {
                return;
            }

            if (this.isOpen()) {
                this.actionMask.queryStatusReport = true;
                this.actionTime.queryStatusReport = now;
                this.serialport.write('?');
            }
        };

        // The throttle function is executed on the trailing edge of the timeout,
        // the function might be executed even if the query timer has been destroyed.
        const queryParserState = _.throttle(() => {
            // Check the ready flag
            if (!(this.ready)) {
                return;
            }

            const now = new Date().getTime();

            // Do not force query parser state ($G) when running a G-code program,
            // it will consume 3 bytes from the receive buffer in each time period.
            // @see https://github.com/cncjs/cncjs/issues/176
            // @see https://github.com/cncjs/cncjs/issues/186
            if ((this.workflow.state === WORKFLOW_STATE_IDLE) && this.controller.isIdle()) {
                const lastQueryTime = this.actionTime.queryParserState;
                if (lastQueryTime > 0) {
                    const timespan = Math.abs(now - lastQueryTime);
                    const toleranceTime = 10000; // 10 seconds

                    // Check if it has not been updated for a long time
                    if (timespan >= toleranceTime) {
                        log.debug(`Continue parser state query: timespan=${timespan}ms`);
                        this.actionMask.queryParserState.state = false;
                        this.actionMask.queryParserState.reply = false;
                    }
                }
            }

            if (this.actionMask.queryParserState.state || this.actionMask.queryParserState.reply) {
                return;
            }

            if (this.isOpen()) {
                this.actionMask.queryParserState.state = true;
                this.actionMask.queryParserState.reply = false;
                this.actionTime.queryParserState = now;
                this.serialport.write('$G\n');
            }
        }, 500);

        this.queryTimer = setInterval(() => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            // Feeder
            if (this.feeder.peek()) {
                this.emit('feeder:status', this.feeder.toJSON());
            }

            // Sender
            if (this.sender.peek()) {
                this.emit('sender:status', this.sender.toJSON());
            }

            const zeroOffset = _.isEqual(
                this.controller.getWorkPosition(this.state),
                this.controller.getWorkPosition(this.controller.state)
            );

            // Smoothie settings
            if (this.settings !== this.controller.settings) {
                this.settings = this.controller.settings;
                this.emit('controller:settings', SMOOTHIE, this.settings);
                this.emit('Smoothie:settings', this.settings); // Backward compatibility
            }

            // Smoothie state
            if (this.state !== this.controller.state) {
                this.state = this.controller.state;
                this.emit('controller:state', SMOOTHIE, this.state);
                this.emit('Smoothie:state', this.state); // Backward compatibility
            }

            // Check the ready flag
            if (!(this.ready)) {
                // Wait for the bootloader to complete before sending commands
                return;
            }

            // ? - Status Report
            queryStatusReport();

            // $G - Parser State
            queryParserState();

            // Check if the machine has stopped movement after completion
            if (this.actionTime.senderFinishTime > 0) {
                const machineIdle = zeroOffset && this.controller.isIdle();
                const now = new Date().getTime();
                const timespan = Math.abs(now - this.actionTime.senderFinishTime);
                const toleranceTime = 500; // in milliseconds

                if (!machineIdle) {
                    // Extend the sender finish time
                    this.actionTime.senderFinishTime = now;
                } else if (timespan > toleranceTime) {
                    log.silly(`Finished sending G-code: timespan=${timespan}`);

                    this.actionTime.senderFinishTime = 0;

                    // Stop workflow
                    this.command(null, 'gcode:stop');
                }
            }
        }, 250);
    }
    populateContext(context) {
        // Machine position
        const {
            x: mposx,
            y: mposy,
            z: mposz,
            a: mposa,
            b: mposb,
            c: mposc
        } = this.controller.getMachinePosition();

        // Work position
        const {
            x: posx,
            y: posy,
            z: posz,
            a: posa,
            b: posb,
            c: posc
        } = this.controller.getWorkPosition();

        return Object.assign(context || {}, {
            // Bounding box
            xmin: Number(context.xmin) || 0,
            xmax: Number(context.xmax) || 0,
            ymin: Number(context.ymin) || 0,
            ymax: Number(context.ymax) || 0,
            zmin: Number(context.zmin) || 0,
            zmax: Number(context.zmax) || 0,
            // Machine position
            mposx: Number(mposx) || 0,
            mposy: Number(mposy) || 0,
            mposz: Number(mposz) || 0,
            mposa: Number(mposa) || 0,
            mposb: Number(mposb) || 0,
            mposc: Number(mposc) || 0,
            // Work position
            posx: Number(posx) || 0,
            posy: Number(posy) || 0,
            posz: Number(posz) || 0,
            posa: Number(posa) || 0,
            posb: Number(posb) || 0,
            posc: Number(posc) || 0
        });
    }
    clearActionValues() {
        this.actionMask.queryParserState.state = false;
        this.actionMask.queryParserState.reply = false;
        this.actionMask.queryStatusReport = false;
        this.actionMask.replyParserState = false;
        this.actionMask.replyStatusReport = false;
        this.actionTime.queryParserState = 0;
        this.actionTime.queryStatusReport = 0;
        this.actionTime.senderFinishTime = 0;
    }
    destroy() {
        this.connections = {};

        if (this.serialport) {
            this.serialport = null;
        }

        if (this.event) {
            this.event = null;
        }

        if (this.feeder) {
            this.feeder = null;
        }

        if (this.sender) {
            this.sender = null;
        }

        if (this.workflow) {
            this.workflow = null;
        }

        if (this.queryTimer) {
            clearInterval(this.queryTimer);
            this.queryTimer = null;
        }

        if (this.controller) {
            this.controller.removeAllListeners();
            this.controller = null;
        }
    }
    initController() {
        const cmds = [
            // Wait for the bootloader to complete before sending commands
            { pauseAfter: 1000 },

            // Check if it is Smoothieware
            { cmd: 'version', pauseAfter: 50 }
        ];

        const sendInitCommands = (i = 0) => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            if (i >= cmds.length) {
                // Set the ready flag to true after sending initialization commands
                this.ready = true;
                return;
            }

            const { cmd = '', pauseAfter = 0 } = { ...cmds[i] };
            if (cmd) {
                this.serialport.write(cmd + '\n');
                log.silly(`> ${cmd}`);
            }
            setTimeout(() => {
                sendInitCommands(i + 1);
            }, pauseAfter);
        };
        sendInitCommands();
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: Object.keys(this.connections),
            ready: this.ready,
            controller: {
                type: this.type,
                settings: this.settings,
                state: this.state
            },
            workflow: {
                state: this.workflow.state,
                context: this.workflow.context
            },
            feeder: this.feeder.toJSON(),
            sender: this.sender.toJSON()
        };
    }
    open(callback = noop) {
        const { port, baudrate } = this.options;

        // Assertion check
        if (this.isOpen()) {
            log.error(`Cannot open serial port "${port}"`);
            return;
        }

        this.serialport = new SerialPort(this.options.port, {
            autoOpen: false,
            baudRate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });
        this.serialport.on('data', this.serialportListener.data);
        this.serialport.on('disconnect', this.serialportListener.disconnect);
        this.serialport.on('error', this.serialportListener.error);
        this.serialport.open((err) => {
            if (err) {
                log.error(`Error opening serial port "${port}":`, err);
                this.emit('serialport:error', { port: port });
                callback(err); // notify error
                return;
            }

            this.emit('serialport:open', {
                port: port,
                baudrate: baudrate,
                controllerType: this.type,
                inuse: true
            });

            // Emit a change event to all connected sockets
            if (this.engine.io) {
                this.engine.io.emit('serialport:change', {
                    port: port,
                    inuse: true
                });
            }

            callback(); // register controller

            log.debug(`Connected to serial port "${port}"`);

            this.workflow.stop();

            // Clear action values
            this.clearActionValues();

            if (this.sender.state.gcode) {
                // Unload G-code
                this.command(null, 'unload');
            }

            // Initialize controller
            this.initController();
        });
    }
    close(callback) {
        const { port } = this.options;

        // Assertion check
        if (!this.serialport) {
            const err = `Serial port "${port}" is not available`;
            callback(new Error(err));
            return;
        }

        // Stop status query
        this.ready = false;

        this.emit('serialport:close', {
            port: port,
            inuse: false
        });

        // Emit a change event to all connected sockets
        if (this.engine.io) {
            this.engine.io.emit('serialport:change', {
                port: port,
                inuse: false
            });
        }

        if (this.isClose()) {
            callback(null);
            return;
        }

        this.serialport.removeListener('data', this.serialportListener.data);
        this.serialport.removeListener('disconnect', this.serialportListener.disconnect);
        this.serialport.removeListener('error', this.serialportListener.error);
        this.serialport.close((err) => {
            if (err) {
                log.error(`Error closing serial port "${port}":`, err);
                callback(err);
                return;
            }

            callback(null);
        });
    }
    isOpen() {
        return this.serialport && this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        if (!socket) {
            log.error('The socket parameter is not specified');
            return;
        }

        log.debug(`Add socket connection: id=${socket.id}`);
        this.connections[socket.id] = socket;

        //
        // Send data to newly connected client
        //
        if (this.isOpen()) {
            socket.emit('serialport:open', {
                port: this.options.port,
                baudrate: this.options.baudrate,
                controllerType: this.type,
                inuse: true
            });
        }
        if (!_.isEmpty(this.settings)) {
            // controller settings
            socket.emit('controller:settings', SMOOTHIE, this.settings);
            socket.emit('Smoothie:settings', this.settings); // Backward compatibility
        }
        if (!_.isEmpty(this.state)) {
            // controller state
            socket.emit('controller:state', SMOOTHIE, this.state);
            socket.emit('Smoothie:state', this.state); // Backward compatibility
        }
        if (this.workflow) {
            // workflow state
            socket.emit('workflow:state', this.workflow.state, this.workflow.context);
        }
        if (this.sender) {
            // sender status
            socket.emit('sender:status', this.sender.toJSON());

            const { name, gcode, context } = this.sender.state;
            if (gcode) {
                socket.emit('gcode:load', name, gcode, context);
            }
        }
    }
    removeConnection(socket) {
        if (!socket) {
            log.error('The socket parameter is not specified');
            return;
        }

        log.debug(`Remove socket connection: id=${socket.id}`);
        this.connections[socket.id] = undefined;
        delete this.connections[socket.id];
    }
    emit(eventName, ...args) {
        Object.keys(this.connections).forEach(id => {
            const socket = this.connections[id];
            socket.emit(eventName, ...args);
        });
    }
    command(socket, cmd, ...args) {
        const handler = {
            'gcode:load': () => {
                let [name, gcode, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                // G4 P0 or P with a very small value will empty the planner queue and then
                // respond with an ok when the dwell is complete. At that instant, there will
                // be no queued motions, as long as no more commands were sent after the G4.
                // This is the fastest way to do it without having to check the status reports.
                const dwell = '%wait ; Wait for the planner queue to empty';
                const ok = this.sender.load(name, gcode + '\n' + dwell, context);
                if (!ok) {
                    callback(new Error(`Invalid G-code: name=${name}`));
                    return;
                }

                this.emit('gcode:load', name, gcode, context);
                this.event.trigger('gcode:load');

                log.debug(`Load G-code: name="${this.sender.state.name}", size=${this.sender.state.gcode.length}, total=${this.sender.state.total}`);

                this.workflow.stop();

                callback(null, this.sender.toJSON());
            },
            'gcode:unload': () => {
                this.workflow.stop();

                // Sender
                this.sender.unload();

                this.emit('gcode:unload');
                this.event.trigger('gcode:unload');
            },
            'start': () => {
                log.warn(`Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:start');
            },
            'gcode:start': () => {
                this.event.trigger('gcode:start');

                this.workflow.start();

                // Feeder
                this.feeder.clear();

                // Sender
                this.sender.next();
            },
            'stop': () => {
                log.warn(`Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:stop');
            },
            // @param {object} options The options object.
            // @param {boolean} [options.force] Whether to force stop a G-code program. Defaults to false.
            'gcode:stop': () => {
                this.event.trigger('gcode:stop');

                this.workflow.stop();

                const activeState = _.get(this.state, 'status.activeState', '');
                if (activeState === SMOOTHIE_ACTIVE_STATE_HOLD) {
                    this.write('~'); // resume
                }
            },
            'pause': () => {
                log.warn(`Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:pause');
            },
            'gcode:pause': () => {
                this.event.trigger('gcode:pause');

                this.workflow.pause();

                this.write('!');
            },
            'resume': () => {
                log.warn(`Warning: The "${cmd}" command is deprecated and will be removed in a future release.`);
                this.command(socket, 'gcode:resume');
            },
            'gcode:resume': () => {
                this.event.trigger('gcode:resume');

                this.write('~');

                this.workflow.resume();
            },
            'feeder:feed': () => {
                const [commands, context = {}] = args;
                this.command(socket, 'gcode', commands, context);
            },
            'feeder:start': () => {
                if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                    return;
                }
                this.write('~');
                this.feeder.unhold();
                this.feeder.next();
            },
            'feeder:pause': () => {
                this.feeder.hold();
            },
            'feeder:stop': () => {
                this.feeder.clear();
                this.feeder.unhold();
            },
            'feedhold': () => {
                this.event.trigger('feedhold');

                this.write('!');
            },
            'cyclestart': () => {
                this.event.trigger('cyclestart');

                this.write('~');
            },
            'statusreport': () => {
                this.write('?');
            },
            'homing': () => {
                this.event.trigger('homing');

                this.writeln('$H');
            },
            'sleep': () => {
                this.event.trigger('sleep');

                // Not supported
            },
            'unlock': () => {
                this.writeln('$X');
            },
            'reset': () => {
                this.workflow.stop();

                // Feeder
                this.feeder.clear();

                this.write('\x18'); // ^x
            },
            // Feed Overrides
            // @param {number} value A percentage value between 10 and 200. A value of zero will reset to 100%.
            'feedOverride': () => {
                const [value] = args;
                let feedOverride = this.controller.state.status.ovF;

                if (value === 0) {
                    feedOverride = 100;
                } else if ((feedOverride + value) > 200) {
                    feedOverride = 200;
                } else if ((feedOverride + value) < 10) {
                    feedOverride = 10;
                } else {
                    feedOverride += value;
                }
                this.command(socket, 'gcode', 'M220S' + feedOverride);

                // enforce state change
                this.controller.state = {
                    ...this.controller.state,
                    status: {
                        ...this.controller.state.status,
                        ovF: feedOverride
                    }
                };
            },
            // Spindle Speed Overrides
            // @param {number} value A percentage value between 10 and 200. A value of zero will reset to 100%.
            'spindleOverride': () => {
                const [value] = args;
                let spindleOverride = this.controller.state.status.ovS;

                if (value === 0) {
                    spindleOverride = 100;
                } else if ((spindleOverride + value) > 200) {
                    spindleOverride = 200;
                } else if ((spindleOverride + value) < 10) {
                    spindleOverride = 10;
                } else {
                    spindleOverride += value;
                }
                this.command(socket, 'gcode', 'M221S' + spindleOverride);

                // enforce state change
                this.controller.state = {
                    ...this.controller.state,
                    status: {
                        ...this.controller.state.status,
                        ovS: spindleOverride
                    }
                };
            },
            // Rapid Overrides
            'rapidOverride': () => {
                // Not supported
            },
            'lasertest:on': () => {
                const [power = 0, duration = 0] = args;

                this.writeln('M3');
                // Firing laser at <power>% power and entering manual mode
                this.writeln('fire ' + ensurePositiveNumber(power));
                if (duration > 0) {
                    // http://smoothieware.org/g4
                    // Dwell S<seconds> or P<milliseconds>
                    // Note that if `grbl_mode` is set to `true`, then the `P` parameter
                    // is the duration to wait in seconds, not milliseconds, as a float value.
                    // This is to confirm to G-code standards.
                    this.writeln('G4P' + ensurePositiveNumber(duration / 1000));
                    // Turning laser off and returning to auto mode
                    this.writeln('fire off');
                    this.writeln('M5');
                }
            },
            'lasertest:off': () => {
                // Turning laser off and returning to auto mode
                this.writeln('fire off');
                this.writeln('M5');
            },
            'gcode': () => {
                const [commands, context] = args;
                const data = ensureArray(commands)
                    .join('\n')
                    .split(/\r?\n/)
                    .filter(line => {
                        if (typeof line !== 'string') {
                            return false;
                        }

                        return line.trim().length > 0;
                    });

                this.feeder.feed(data, context);

                if (!this.feeder.isPending()) {
                    this.feeder.next();
                }
            },
            'macro:run': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:run');

                this.command(socket, 'gcode', macro.content, context);
                callback(null);
            },
            'macro:load': () => {
                let [id, context = {}, callback = noop] = args;
                if (typeof context === 'function') {
                    callback = context;
                    context = {};
                }

                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('macro:load');

                this.command(socket, 'gcode:load', macro.name, macro.content, context, callback);
            },
            'watchdir:load': () => {
                const [file, callback = noop] = args;
                const context = {}; // empty context

                monitor.readFile(file, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this.command(socket, 'gcode:load', file, data, context, callback);
                });
            }
        }[cmd];

        if (!handler) {
            log.error(`Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(data, context) {
        // Assertion check
        if (this.isClose()) {
            log.error(`Serial port "${this.options.port}" is not accessible`);
            return;
        }

        const cmd = data.trim();
        this.actionMask.replyStatusReport = (cmd === '?') || this.actionMask.replyStatusReport;
        this.actionMask.replyParserState = (cmd === '$G') || this.actionMask.replyParserState;

        this.emit('serialport:write', data, context);
        this.serialport.write(data);
        log.silly(`> ${data}`);
    }
    writeln(data, context) {
        if (_.includes(SMOOTHIE_REALTIME_COMMANDS, data)) {
            this.write(data, context);
        } else {
            this.write(data + '\n', context);
        }
    }
}

export default SmoothieController;
