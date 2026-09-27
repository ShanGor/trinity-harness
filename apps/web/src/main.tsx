import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp } from 'antd';

import App from './App.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <AntdApp style={{ height: '100%' }}>
      <App />
    </AntdApp>
  </StrictMode>,
);
