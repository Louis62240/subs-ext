// Registre des providers. Ordre = ordre par défaut (modifiable dans les options).
import * as soustitres from './soustitres.js';
import * as addic7ed from './addic7ed.js';
import * as tvsubtitles from './tvsubtitles.js';
import * as yify from './yify.js';

export const PROVIDERS = { soustitres, addic7ed, tvsubtitles, yify };
export const DEFAULT_ORDER = ['soustitres', 'addic7ed', 'tvsubtitles', 'yify'];
