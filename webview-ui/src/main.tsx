import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDetailsMotion } from './motion';
import './styles/theme.css';
import './styles/subpages.css';
import './styles/workSurface.css';
import './styles/agentObservation.css';
import './styles/backgroundTasks.css';

installDetailsMotion();

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}
