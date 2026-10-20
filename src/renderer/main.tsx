import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { store } from './store';

void store.connect();
createRoot(document.getElementById('root')!).render(<App />);
