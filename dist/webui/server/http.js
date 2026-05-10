export function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
export function readJsonBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 2_000_000) {
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            try {
                resolveBody(body ? JSON.parse(body) : {});
            }
            catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
