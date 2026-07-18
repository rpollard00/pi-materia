import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { CentralAdminApp } from './central-admin/CentralAdminApp.js';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CentralAdminApp />
  </React.StrictMode>,
);
