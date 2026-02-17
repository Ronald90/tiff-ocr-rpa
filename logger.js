import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('./rpa.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

// Stream de escritura
let logStream = null;

// Nivel de debug controlado por variable de entorno
const DEBUG_ENABLED = process.env.LOG_DEBUG === 'true';

function timestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function isoTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function rotateIfNeeded() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const stat = fs.statSync(LOG_FILE);
            if (stat.size > MAX_LOG_SIZE) {
                // Cerrar stream actual síncronamente antes de rotar
                if (logStream) {
                    logStream.end();
                    logStream = null;
                }
                const rotated = LOG_FILE.replace('.log', `_${isoTimestamp()}.log`);
                fs.renameSync(LOG_FILE, rotated);
            }
        }
    } catch (err) {
        console.error('Error rotando logs:', err.message);
    }
}

function initStream() {
    if (!logStream) {
        // Flags: 'a' = append
        logStream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });

        logStream.on('error', (err) => {
            console.error('Error escritura log:', err);
        });
    }
}

function write(level, message) {
    const line = `[${timestamp()}] [${level}] ${message}`;
    console.log(line);

    // Asegurar que el stream esté listo
    if (!logStream) initStream();

    const written = logStream.write(line + '\n');

    // Si el buffer interno está lleno, podríamos esperar 'drain', 
    // pero para logs generalmente seguimos escribiendo o dejamos 
    // que Node maneje el backpressure (buffer en memoria).
}

// Rotar log al iniciar si es necesario
rotateIfNeeded();
initStream();

// Cierre limpio
process.on('exit', () => {
    if (logStream) logStream.end();
});

const logger = {
    info: (msg) => write('INFO', msg),
    success: (msg) => write('OK', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    debug: (msg) => { if (DEBUG_ENABLED) write('DEBUG', msg); },
    separator: () => write('INFO', '─'.repeat(50)),
};

export default logger;
