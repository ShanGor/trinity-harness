import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';

import App from './App.js';

import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#116149',
          borderRadius: 12,
          colorText: '#172133',
          fontFamily: '"IBM Plex Sans", "Source Sans 3", "Avenir Next", "Segoe UI", sans-serif',
        },
      }}
    >
      <AntdApp style={{ height: '100%' }}>
        <App />
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);
