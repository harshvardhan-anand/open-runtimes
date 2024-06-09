const fs = require("fs");
const micro = require("micro");
const util = require("util");
const { buffer, send } = require("micro");

const USER_CODE_PATH = '/usr/local/server/src/function';

const server = micro(async (req, res) => {
    try {
        await action(req, res);
    } catch(e) {
        const logs = [];
        const errors = [e.stack || e];
        res.setHeader('x-open-runtimes-logs', encodeURIComponent(logs.join('\n')));
        res.setHeader('x-open-runtimes-errors', encodeURIComponent(errors.join('\n')));
        return send(res, 500, '');
    }
});

const action = async (req, res) => {
    const timeout = req.headers[`x-open-runtimes-timeout`] ?? '';
    let safeTimeout = null;
    if(timeout) {
        if(isNaN(timeout) || timeout === 0) {
            return send(res, 500, 'Header "x-open-runtimes-timeout" must be an integer greater than 0.');
        }
        
        safeTimeout = +timeout;
    }

    if(process.env['OPEN_RUNTIMES_SECRET'] && req.headers[`x-open-runtimes-secret`] !== process.env['OPEN_RUNTIMES_SECRET']) {
        return send(res, 500, 'Unauthorized. Provide correct "x-open-runtimes-secret" header.');
    }

    const logs = [];
    const errors = [];

    const contentType = req.headers['content-type'] ?? 'text/plain';
    const bodyBinary = await buffer(req);

    const headers = {};
    Object.keys(req.headers).filter((header) => !header.toLowerCase().startsWith('x-open-runtimes-')).forEach((header) => {
        headers[header.toLowerCase()] = req.headers[header];
    });

    const scheme = (req.headers['x-forwarded-proto'] ?? 'http');
    const defaultPort = scheme === 'https' ? '443' : '80';
    const host = req.headers['host'].includes(':') ? req.headers['host'].split(':')[0] : req.headers['host'];
    const port = +(req.headers['host'].includes(':') ? req.headers['host'].split(':')[1] : defaultPort);
    const path = req.url.includes('?') ? req.url.split('?')[0] : req.url;
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
    const query = {};
    for(const param of queryString.split('&')) {
        let [key, ...valueArr] = param.split('=');
        const value = valueArr.join('=');

        if(key) {
            query[key] = value ?? '';
        }
    }

    const url = `${scheme}://${host}${port.toString() === defaultPort ? '' : `:${port}`}${path}${queryString === '' ? '' : `?${queryString}`}`;

    let chunkHeadersSent = false;

    const context = {
        req: {
            get body() {
                if(contentType.includes("application/json")) {
                    return this.bodyJson;
                }

                const binaryTypes = ["audio/", "video/", "octet", "binary"];
                for(const type of binaryTypes) {
                    if(contentType.includes(type)) {
                        return this.bodyBinary;
                    }
                }

                return this.bodyText;
            },
            get bodyRaw() {
                return this.bodyText;
            },
            get bodyText() {
                return bodyBinary.toString();
            },
            get bodyJson() {
                return JSON.parse(this.bodyText);
            },
            get bodyBinary() {
                return bodyBinary;
            },
            headers,
            method: req.method,
            host,
            scheme,
            query,
            queryString,
            port,
            url,
            path
        },
        res: {
            send: function (body, statusCode = 200, headers = {}) {
                return this.text(body, statusCode, headers);
            },
            text: function (body, statusCode = 200, headers = {}) {
                return this.binary(Buffer.from(body, 'utf8'), statusCode, headers)
            },
            binary: function(bytes, statusCode = 200, headers = {}) {
                return {
                    body: bytes,
                    statusCode: statusCode,
                    headers: headers,
                    chunked: false
                }
            },
            json: function (obj, statusCode = 200, headers = {}) {
                headers['content-type'] = 'application/json';
                return this.text(JSON.stringify(obj), statusCode, headers);
            },
            empty: function () {
                return this.text('', 204, {});
            },
            redirect: function (url, statusCode = 301, headers = {}) {
                headers['location'] = url;
                return this.text('', statusCode, headers);
            },
            start: function(statusCode = 200, headers = {}) {
                if(!chunkHeadersSent) {
                    chunkHeadersSent = true;
                    headers['cache-control'] = headers['content-type'] ?? 'no-store';
                    headers['content-type'] = headers['content-type'] ?? 'text/event-stream';
                    headers['connection'] = headers['connection'] ?? 'keep-alive';
                    headers['transfer-encoding'] = headers['transfer-encoding'] ?? 'chunked';
                    res.writeHead(statusCode, headers);
                } else {
                    throw new Error('You can only call res.start() once');
                }
            },
            writeText: function(body) {
                this.writeBinary(Buffer.from(body, 'utf8'));
            },
            writeJson: function(body) {
                this.writeText(JSON.stringify(body));
            },
            writeBinary: function(bytes) {
                if(!chunkHeadersSent) {
                    throw new Error('You must call res.start() to start a chunk response.');
                }

                res.write(bytes);
            },
            end: function(headers = {}) {
                if(!chunkHeadersSent) {
                    throw new Error('You must call res.start() to start a chunk response.');
                }

                return {
                    body: "",
                    statusCode: 0,
                    headers: headers,
                    chunked: true
                };
            }
        },
        log: function (message) {
            if (message instanceof Object || Array.isArray(message)) {
                logs.push(JSON.stringify(message));
            } else {
                logs.push(message + "");
            }
        },
        error: function (message) {
            if (message instanceof Object || Array.isArray(message)) {
                errors.push(JSON.stringify(message));
            } else {
                errors.push(message + "");
            }
        },
    };

    console.stdlog = console.log.bind(console);
    console.stderror = console.error.bind(console);
    console.stdinfo = console.info.bind(console);
    console.stddebug = console.debug.bind(console);
    console.stdwarn = console.warn.bind(console);

    let customstd = "";
    console.log = console.info = console.debug = console.warn = console.error = function() {
        customstd += util.format.apply(null, arguments) + '\n';
    }

    let output = null;

    async function execute() {
        let userFunction;
        try {
            userFunction = require(USER_CODE_PATH + '/' + process.env.OPEN_RUNTIMES_ENTRYPOINT);
        } catch(err) {
            if(err.code === 'ERR_REQUIRE_ESM') {
                userFunction = await import(USER_CODE_PATH + '/' + process.env.OPEN_RUNTIMES_ENTRYPOINT);
            } else {
                throw err;
            }
        }

        if (!(userFunction || userFunction.constructor || userFunction.call || userFunction.apply)) {
            throw new Error("User function is not valid.");
        }

        if (userFunction.default) {
            if (!(userFunction.default.constructor || userFunction.default.call || userFunction.default.apply)) {
                throw new Error("User function is not valid.");
            }

            output = await userFunction.default(context);
        } else {
            output = await userFunction(context);
        }
    }

    try {
        if(safeTimeout !== null) {
            let executed = true;

            const timeoutPromise = new Promise((promiseRes) => {
                setTimeout(() => {
                    executed = false;
                    promiseRes(true);
                }, safeTimeout * 1000);
            });

            await Promise.race([execute(), timeoutPromise]);

            if(!executed) {
                context.error('Execution timed out.');
                output = context.res.send('', 500, {});

                if(chunkHeadersSent) {
                    output = context.res.end();
                } else {
                    output = context.res.send('', 500, {});
                }
            }
        } else {
            await execute();
        }
    } catch (e) {
        if(e.code === 'MODULE_NOT_FOUND') {
            context.error('Could not load code file.');
        }

        context.error(e.stack || e);

        if(chunkHeadersSent) {
            output = context.res.end();
        } else {
            output = context.res.send('', 500, {});
        }
    } finally {
        console.log = console.stdlog;
        console.error = console.stderror;
        console.debug = console.stddebug;
        console.warn = console.stdwarn;
        console.info = console.stdinfo;
    }

    if(output === null || output === undefined) {
        context.error('Return statement missing. return context.res.empty() if no response is expected.');

        if(chunkHeadersSent) {
            output = context.res.end();
        } else {
            output = context.res.send('', 500, {});
        }
    }

    output.chunked = output.chunked ?? false;
    output.body = output.body ?? '';
    output.statusCode = output.statusCode ?? 200;
    output.headers = output.headers ?? {};

    const responseHeaders = {};

    for (const header in output.headers) {
        if(header.toLowerCase().startsWith('x-open-runtimes-')) {
            continue;
        }

        responseHeaders[header.toLowerCase()] = output.headers[header];
    }

    const contentTypeValue = responseHeaders["content-type"] ?? "text/plain";
    if (
        !contentTypeValue.startsWith("multipart/") &&
        !contentTypeValue.includes("charset=")
    ) {
        responseHeaders["content-type"] = contentTypeValue + "; charset=utf-8";
    }

    if(customstd) {
        context.log('');
        context.log('----------------------------------------------------------------------------');
        context.log('Unsupported logs detected. Use context.log() or context.error() for logging.');
        context.log('----------------------------------------------------------------------------');
        context.log(customstd);
        context.log('----------------------------------------------------------------------------');
    }

    responseHeaders['x-open-runtimes-logs'] = encodeURIComponent(logs.join('\n'));
    responseHeaders['x-open-runtimes-errors'] = encodeURIComponent(errors.join('\n'));

    if(output.chunked) {
        res.addTrailers(responseHeaders);
        res.end();
        return;
    } else {
        for(const headerName in responseHeaders) {
            res.setHeader(headerName, responseHeaders[headerName]);
        }
        return send(res, output.statusCode, output.body);
    }
};

server.listen(3000);