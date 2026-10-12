import { requestExpandedMode } from '@devvit/web/client';
import { loadMessages, translateStatic } from './i18n.js';

await loadMessages();

translateStatic();

document.getElementById('open')?.addEventListener('click', (event) => requestExpandedMode(event, 'backtest'));
