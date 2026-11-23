import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';

import App from './App.js';

import './index.css';
import './glass-materials.css';

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
          colorTextSecondary: '#59656d',
          colorBorder: '#dce1e5',
          colorBgLayout: '#f7f8fa',
          controlHeight: 40,
          controlHeightSM: 32,
          fontSize: 14,
          lineHeight: 1.6,
          borderRadius: 12,
          borderRadiusLG: 20,
          borderRadiusSM: 10,
          colorText: '#22292d',
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
