import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('./rpa.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

// Buffer para escritura eficiente
let writeBuffer = [];
let flushTimer = null;

// Nivel de debug controlado por variable de entorno
const DEBUG_ENABLED = process.env.LOG_DEBUG === 'true';

function timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function isoTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function rotateIfNeeded() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const stat = fs.statSync(LOG_FILE);
            if (stat.size > MAX_LOG_SIZE) {
                const rotated = LOG_FILE.replace('.log', `_${isoTimestamp()}.log`);
                fs.renameSync(LOG_FILE, rotated);
            }
        }
    } catch { /* ignore rotation errors */ }
}

function flushBuffer() {
    if (writeBuffer.length === 0) return;
    const content = writeBuffer.join('\n') + '\n';
    writeBuffer = [];
    try {
        fs.appendFileSync(LOG_FILE, content);
    } catch { /* ignore write errors */ }
}

function write(level, message) {
    const line = `[${timestamp()}] [${level}] ${message}`;
    console.log(line);
    writeBuffer.push(line);

    // Flush cada 500ms o cuando hay 20+ líneas
    if (writeBuffer.length >= 20) {
        flushBuffer();
    } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushBuffer();
            flushTimer = null;
        }, 500);
    }
}

// Flush al salir
process.on('exit', flushBuffer);

// Rotar log al iniciar si es necesario
rotateIfNeeded();

const logger = {
    info: (msg) => write('INFO', msg),
    success: (msg) => write('OK', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    debug: (msg) => { if (DEBUG_ENABLED) write('DEBUG', msg); },
    separator: () => write('INFO', '─'.repeat(50)),
    flush: flushBuffer,
};

export default logger;
