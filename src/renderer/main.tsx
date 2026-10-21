import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { store } from './store';
import { startThemes } from './theme';

startThemes();
void store.connect();
createRoot(document.getElementById('root')!).render(<App />);
