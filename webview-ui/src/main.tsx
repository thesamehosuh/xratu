import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDetailsMotion } from './motion';
import './styles/theme.css';

installDetailsMotion();

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}
