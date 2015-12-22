import i18n from 'i18next';
import React from 'react';
import serialport from '../../lib/serialport';

class GrblQuickAccessToolbar extends React.Component {
    handleReset() {
        serialport.write('\x18');
    }
    handleHome() {
        serialport.writeln('$H');
    }
    handleUnlock() {
        serialport.writeln('$X');
    }
    render() {
        return (
            <div className="grbl-quick-access-toolbar">
                <div className="btn-group btn-group-sm" role="group">
                    <button type="button" className="btn btn-success" onClick={::this.handleHome} title={i18n._('Run homing cycle ($H)')}><i className="ion-home"></i>&nbsp;{i18n._('Home')}</button>
                    <button type="button" className="btn btn-warning" onClick={::this.handleUnlock} title={i18n._('Kill alarm lock ($X)')}><i className="ion-unlocked"></i>&nbsp;{i18n._('Unlock')}</button>
                    <button type="button" className="btn btn-danger" onClick={::this.handleReset} title={i18n._('Reset Grbl (Ctrl-X)')}><i className="ion-refresh mirror"></i>&nbsp;{i18n._('Reset')}</button>
                </div>
            </div>
        );
    }
}

export default GrblQuickAccessToolbar;
