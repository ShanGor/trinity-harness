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
          colorPrimary: '#24634b',
          colorInfo: '#24634b',
          colorTextSecondary: '#626e65',
          colorBorder: '#e1e5df',
          colorBgLayout: '#f6f7f5',
          controlHeight: 40,
          controlHeightSM: 32,
          fontSize: 14,
          lineHeight: 1.6,
          borderRadius: 8,
          colorText: '#202923',
          fontFamily: 'var(--font-ui)',
          fontFamilyCode: 'var(--font-code)',
        },
      }}
    >
      <AntdApp style={{ height: '100%' }}>
        <App />
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
);
