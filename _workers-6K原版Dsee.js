import { connect } from 'cloudflare:sockets';

// ======================================
// Configuration
// ======================================

const DEFAULT_USER_ID = '480b1159-07b7-4863-ad1b-11df756f6f13';
const DEFAULT_PROXY_IPS = ['gb.luton.eu.org:443'];

// 预编译正则表达式
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROXY_PATTERN = /^([\w.-]+|\d+\.\d+\.\d+\.\d+|\[[\da-fA-F:]+\]):\d{1,5}$/;
const SOCKS5_PATTERN = /^((\w+:\w+@)?[\w.-]+|\d+\.\d+\.\d+\.\d+):\d{1,5}$/;

// WebSocket状态常量
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
    async fetch(request, env, ctx) {
        try {
            // 设置响应超时
            ctx.waitUntil(new Promise(resolve => setTimeout(resolve, 29000)));

            const url = new URL(request.url);
            const host = request.headers.get('Host') || url.hostname;

            // 处理WebSocket升级
            if (request.headers.get('Upgrade') === 'websocket') {
                return await handleWebSocketRequest(request, env);
            }

            // 处理普通HTTP请求
            return await handleHttpRequest(request, env, url, host);

        } catch (error) {
            console.error('Global error handler:', error);
            return new Response('Internal Server Error', { 
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    }
};

// ======================================
// HTTP Request Handler
// ======================================

async function handleHttpRequest(request, env, url, host) {
    const userID = env.UUID || DEFAULT_USER_ID;
    
    // 快速路径检查
    if (url.pathname === '/cf') {
        return new Response(JSON.stringify(request.cf, null, 2), {
            headers: { 'Content-Type': 'application/json;charset=utf-8' }
        });
    }

    // 验证UUID格式
    if (!isValidUUID(userID)) {
        return new Response('Invalid UUID format', { status: 400 });
    }

    const userIDs = userID.includes(',') ? userID.split(',').map(id => id.trim()) : [userID];
    const path = url.pathname;

    // 检查用户ID路径匹配
    for (const uid of userIDs) {
        if (path === `/${uid}` || path === `/sub/${uid}` || path === `/bestip/${uid}`) {
            return await handleUserPath(request, uid, path, host, env);
        }
    }

    // 默认返回网盘页面
    return generateDrivePage(host);
}

async function handleUserPath(request, userID, path, host, env) {
    const proxyIP = env.PROXYIP || DEFAULT_PROXY_IPS[0];
    const proxyAddresses = proxyIP.includes(',') ? 
        proxyIP.split(',').map(addr => addr.trim()) : 
        [proxyIP];

    if (path === `/bestip/${userID}`) {
        return fetch(`https://bestip.06151953.xyz/auto?host=${host}&uuid=${userID}&path=/`, {
            headers: request.headers
        });
    }

    const isSubscription = path.startsWith('/sub/');
    const content = isSubscription ?
        generateSubscription(userID, host, proxyAddresses) :
        generateConfigPage(userID, host, proxyAddresses);

    return new Response(content, {
        headers: {
            'Content-Type': isSubscription ? 
                'text/plain;charset=utf-8' : 
                'text/html;charset=utf-8'
        }
    });
}

// ======================================
// WebSocket Handler
// ======================================

async function handleWebSocketRequest(request, env) {
    try {
        const userID = env.UUID || DEFAULT_USER_ID;
        
        if (!isValidUUID(userID)) {
            throw new Error('Invalid UUID for WebSocket connection');
        }

        // @ts-ignore
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        server.accept();
        
        // 立即开始处理WebSocket数据流
        handleWebSocketStream(server, userID, env).catch(error => {
            console.error('WebSocket stream error:', error);
            safeCloseWebSocket(server);
        });

        return new Response(null, {
            status: 101,
            // @ts-ignore
            webSocket: client,
        });

    } catch (error) {
        console.error('WebSocket setup error:', error);
        return new Response('WebSocket upgrade failed', { status: 400 });
    }
}

async function handleWebSocketStream(webSocket, userID, env) {
    const config = {
        userID,
        proxyIP: env.PROXYIP ? env.PROXYIP.split(':')[0] : DEFAULT_PROXY_IPS[0].split(':')[0],
        proxyPort: env.PROXYIP ? (env.PROXYIP.split(':')[1] || '443') : '443',
        socks5Address: env.SOCKS5 || '',
        socks5Relay: env.SOCKS5_RELAY === 'true'
    };

    let remoteSocket = null;
    let isDns = false;

    webSocket.addEventListener('message', async (event) => {
        try {
            const data = event.data;
            
            if (isDns) {
                await handleDNSQuery(data, webSocket);
                return;
            }

            if (remoteSocket) {
                await forwardDataToSocket(remoteSocket, data);
                return;
            }

            // 处理协议头
            const header = parseProtocolHeader(data, userID);
            if (header.hasError) {
                throw new Error(header.message);
            }

            if (header.isUDP) {
                if (header.portRemote === 53) {
                    isDns = true;
                    await handleDNSQuery(data.slice(header.rawDataIndex), webSocket);
                } else {
                    throw new Error('UDP only supported for DNS');
                }
                return;
            }

            // 建立TCP连接
            remoteSocket = await establishConnection(header, config);
            await forwardDataToSocket(remoteSocket, data.slice(header.rawDataIndex));
            
            // 开始从远程socket读取数据
            pipeSocketToWebSocket(remoteSocket, webSocket, header.protocolVersion);

        } catch (error) {
            console.error('WebSocket message error:', error);
            safeCloseWebSocket(webSocket);
        }
    });

    webSocket.addEventListener('close', () => {
        if (remoteSocket) {
            safeCloseSocket(remoteSocket);
        }
    });

    webSocket.addEventListener('error', (error) => {
        console.error('WebSocket error:', error);
        if (remoteSocket) {
            safeCloseSocket(remoteSocket);
        }
    });
}

// ======================================
// Connection Management
// ======================================

async function establishConnection(header, config) {
    try {
        let socket;
        
        if (config.socks5Relay && config.socks5Address) {
            socket = await connectViaSocks5(header, config.socks5Address);
        } else {
            // 使用代理或直连
            const targetHost = config.proxyIP || header.addressRemote;
            const targetPort = config.proxyPort || header.portRemote;
            
            socket = connect({
                hostname: targetHost,
                port: parseInt(targetPort)
            });
        }

        return socket;
    } catch (error) {
        console.error('Connection failed:', error);
        throw new Error(`Failed to establish connection: ${error.message}`);
    }
}

async function connectViaSocks5(header, socks5Address) {
    // 简化的SOCKS5实现
    const parsed = parseSocks5Address(socks5Address);
    const socket = connect({
        hostname: parsed.hostname,
        port: parsed.port
    });

    // SOCKS5握手过程
    const writer = socket.writable.getWriter();
    
    // 发送问候
    await writer.write(new Uint8Array([0x05, 0x01, 0x00]));
    
    // 这里简化了SOCKS5认证过程
    // 实际实现需要完整的SOCKS5协议处理
    
    writer.releaseLock();
    return socket;
}

async function forwardDataToSocket(socket, data) {
    const writer = socket.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
}

async function pipeSocketToWebSocket(socket, webSocket, protocolVersion) {
    try {
        const reader = socket.readable.getReader();
        const responseHeader = new Uint8Array([protocolVersion[0], 0]);
        let isFirstChunk = true;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                break;
            }

            if (isFirstChunk) {
                // 合并协议头和第一块数据
                const combined = new Uint8Array(responseHeader.length + value.length);
                combined.set(responseHeader);
                combined.set(value, responseHeader.length);
                webSocket.send(combined);
                isFirstChunk = false;
            } else {
                webSocket.send(value);
            }
        }
    } catch (error) {
        console.error('Pipe socket error:', error);
    } finally {
        safeCloseSocket(socket);
    }
}

// ======================================
// Protocol Parser
// ======================================

function parseProtocolHeader(buffer, userID) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) {
        return { hasError: true, message: 'Invalid data length' };
    }

    try {
        const dataView = new DataView(buffer);
        const version = dataView.getUint8(0);
        
        // 提取UUID (位置1-17)
        const uuidBytes = new Uint8Array(buffer.slice(1, 17));
        const receivedUUID = bytesToUUID(uuidBytes);

        // 验证UUID
        const validUUIDs = userID.includes(',') ? userID.split(',').map(id => id.trim()) : [userID];
        if (!validUUIDs.includes(receivedUUID)) {
            return { hasError: true, message: 'Invalid user' };
        }

        const optLength = dataView.getUint8(17);
        const command = dataView.getUint8(18 + optLength);

        // 只支持TCP和UDP
        if (command !== 1 && command !== 2) {
            return { hasError: true, message: `Unsupported command: ${command}` };
        }

        const portIndex = 18 + optLength + 1;
        const portRemote = dataView.getUint16(portIndex);
        const addressType = dataView.getUint8(portIndex + 2);

        let addressRemote, rawDataIndex;

        switch (addressType) {
            case 1: // IPv4
                addressRemote = Array.from(new Uint8Array(buffer.slice(portIndex + 3, portIndex + 7)))
                    .join('.');
                rawDataIndex = portIndex + 7;
                break;
                
            case 2: // Domain
                const domainLength = dataView.getUint8(portIndex + 3);
                addressRemote = new TextDecoder().decode(
                    buffer.slice(portIndex + 4, portIndex + 4 + domainLength)
                );
                rawDataIndex = portIndex + 4 + domainLength;
                break;
                
            case 3: // IPv6
                const ipv6Bytes = new Uint16Array(buffer.slice(portIndex + 3, portIndex + 19));
                addressRemote = Array.from(ipv6Bytes, num => 
                    num.toString(16).padStart(4, '0')
                ).join(':');
                rawDataIndex = portIndex + 19;
                break;
                
            default:
                return { hasError: true, message: `Invalid address type: ${addressType}` };
        }

        return {
            hasError: false,
            addressRemote,
            addressType,
            portRemote,
            rawDataIndex,
            protocolVersion: new Uint8Array([version]),
            isUDP: command === 2
        };

    } catch (error) {
        return { hasError: true, message: `Protocol parse error: ${error.message}` };
    }
}

// ======================================
// DNS Handler
// ======================================

async function handleDNSQuery(udpData, webSocket, responseHeader = null) {
    try {
        const dnsSocket = connect({
            hostname: '8.8.8.8',
            port: 53
        });

        const writer = dnsSocket.writable.getWriter();
        await writer.write(udpData);
        writer.releaseLock();

        const reader = dnsSocket.readable.getReader();
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                if (responseHeader) {
                    const combined = new Uint8Array(responseHeader.length + value.length);
                    combined.set(responseHeader);
                    combined.set(value, responseHeader.length);
                    webSocket.send(combined);
                    responseHeader = null;
                } else {
                    webSocket.send(value);
                }
            }
        }
    } catch (error) {
        console.error('DNS query error:', error);
    }
}

// ======================================
// Utility Functions
// ======================================

function isValidUUID(uuid) {
    return UUID_REGEX.test(uuid);
}

function bytesToUUID(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeCloseWebSocket(ws) {
    try {
        if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
            ws.close();
        }
    } catch (error) {
        // 忽略关闭错误
    }
}

function safeCloseSocket(socket) {
    try {
        socket.close();
    } catch (error) {
        // 忽略关闭错误
    }
}

function parseSocks5Address(address) {
    const parts = address.split('@');
    let username, password, hostname, port;

    if (parts.length === 2) {
        [username, password] = parts[0].split(':');
        [hostname, port] = parts[1].split(':');
    } else {
        [hostname, port] = address.split(':');
    }

    return {
        username,
        password,
        hostname,
        port: parseInt(port) || 1080
    };
}

// ======================================
// Content Generators (简化版本)
// ======================================

function generateConfigPage(userID, host, proxyAddresses) {
    const mainConfig = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${host}`;
    
    return `<!DOCTYPE html>
<html>
<head>
    <title>Config</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .config { background: #f5f5f5; padding: 20px; border-radius: 5px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>Configuration</h1>
    <div class="config">
        <h3>Main Config:</h3>
        <pre>${mainConfig}</pre>
        <button onclick="navigator.clipboard.writeText('${mainConfig}')">Copy</button>
    </div>
    <p><a href="/sub/${userID}">Subscription Link</a></p>
</body>
</html>`;
}

function generateSubscription(userID, host, proxyAddresses) {
    const configs = [
        `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${host}`
    ];
    
    // 添加代理配置
    for (const proxy of proxyAddresses) {
        const [hostname, port = '443'] = proxy.split(':');
        configs.push(`vless://${userID}@${hostname}:${port}?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2048#${host}-proxy`);
    }
    
    return btoa(configs.join('\n'));
}

function generateDrivePage(host) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Cloud Drive - ${host}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: #f4f4f4; 
        }
        .container { 
            max-width: 800px; 
            margin: 0 auto; 
            background: white; 
            padding: 20px; 
            border-radius: 8px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
        }
        h1 { color: #333; }
        .upload-area { 
            border: 2px dashed #ccc; 
            padding: 40px; 
            text-align: center; 
            margin: 20px 0; 
            border-radius: 5px; 
            cursor: pointer; 
        }
        .upload-area:hover { 
            border-color: #666; 
            background: #f9f9f9; 
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Cloud Drive</h1>
        <p>Welcome to your cloud storage</p>
        <div class="upload-area" onclick="alert('Upload functionality would go here')">
            <h3>Upload Files</h3>
            <p>Click or drag files here to upload</p>
        </div>
    </div>
</body>
</html>`;
}