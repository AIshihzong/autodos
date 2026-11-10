import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const native = (window as any).autodos;
if (native?.desktop) document.body.classList.add('desktop', `platform-${native.platform}`);

createRoot(document.getElementById('root')!).render(<App />);
