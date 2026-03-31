import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const PALETTE = [
  '#101418',
  '#ffffff',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#0f766e',
  '#06b6d4',
  '#2563eb',
  '#7c3aed',
  '#be123c',
  '#ec4899',
  '#7c2d12',
]
const BRUSHES = [4, 8, 12, 18]
const ROUND_OPTIONS = [2, 3, 4, 5, 6, 8, 10]

const initialRoomCode = (() => {
  const roomFromQuery = new URLSearchParams(window.location.search).get('room')
  return roomFromQuery?.toUpperCase().slice(0, 6) || Math.random().toString(36).slice(2, 8).toUpperCase()
})()

const emptyGame = {
  meId: '',
  roomCode: '',
  phase: 'lobby',
  round: 0,
  maxRounds: 6,
  timeLeft: 0,
  answer: '게임 대기 중',
  resultText: '방에 입장해 게임을 시작하세요.',
  drawerId: null,
  drawerName: '대기 중',
  isHost: false,
  canStart: false,
  players: [],
  messages: [],
}

function getServerUrl() {
  const configuredUrl = import.meta.env.VITE_SERVER_URL?.trim()

  if (configuredUrl) {
    return configuredUrl
  }

  if (import.meta.env.DEV) {
    return `${window.location.protocol}//${window.location.hostname}:3001`
  }

  return undefined
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function getPhaseLabel(phase) {
  if (phase === 'drawing') {
    return '진행 중'
  }

  if (phase === 'round-end') {
    return '정답 공개'
  }

  return '로비'
}

function getResultTone(game) {
  if (game.phase === 'round-end' && game.resultText.includes('정답!')) {
    return 'correct'
  }

  if (game.phase === 'round-end') {
    return 'round-end'
  }

  return 'default'
}

function hexToRgba(hexColor) {
  const value = String(hexColor || '').replace('#', '').trim()

  if (value.length !== 6) {
    return null
  }

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    a: 255,
  }
}

function rgbaMatches(data, index, rgba, tolerance = 8) {
  return (
    Math.abs(data[index] - rgba.r) <= tolerance &&
    Math.abs(data[index + 1] - rgba.g) <= tolerance &&
    Math.abs(data[index + 2] - rgba.b) <= tolerance &&
    Math.abs(data[index + 3] - rgba.a) <= tolerance
  )
}

function clearCanvasElement(canvas) {
  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d')
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.restore()
}

function floodFillCanvas(canvas, action) {
  if (!canvas || !action?.point) {
    return
  }

  const context = canvas.getContext('2d', { willReadFrequently: true })
  const fillColor = hexToRgba(action.color)

  if (!fillColor) {
    return
  }

  const startX = Math.min(canvas.width - 1, Math.max(0, Math.floor(action.point.x * canvas.width)))
  const startY = Math.min(canvas.height - 1, Math.max(0, Math.floor(action.point.y * canvas.height)))
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data, width, height } = imageData
  const startIndex = (startY * width + startX) * 4
  const targetColor = {
    r: data[startIndex],
    g: data[startIndex + 1],
    b: data[startIndex + 2],
    a: data[startIndex + 3],
  }

  if (rgbaMatches(data, startIndex, fillColor, 0)) {
    return
  }

  const stack = [[startX, startY]]

  while (stack.length) {
    const nextPoint = stack.pop()

    if (!nextPoint) {
      continue
    }

    const [x, y] = nextPoint

    if (x < 0 || x >= width || y < 0 || y >= height) {
      continue
    }

    const pixelIndex = (y * width + x) * 4

    if (!rgbaMatches(data, pixelIndex, targetColor)) {
      continue
    }

    data[pixelIndex] = fillColor.r
    data[pixelIndex + 1] = fillColor.g
    data[pixelIndex + 2] = fillColor.b
    data[pixelIndex + 3] = fillColor.a

    stack.push([x + 1, y])
    stack.push([x - 1, y])
    stack.push([x, y + 1])
    stack.push([x, y - 1])
  }

  context.putImageData(imageData, 0, 0)
}

function drawStrokeOnCanvas(canvas, segment) {
  if (!canvas) {
    return
  }

  const context = canvas.getContext('2d')
  const width = canvas.clientWidth
  const height = canvas.clientHeight

  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = segment.size
  context.globalCompositeOperation = segment.mode === 'erase' ? 'destination-out' : 'source-over'
  context.strokeStyle = segment.mode === 'erase' ? 'rgba(0,0,0,1)' : segment.color
  context.beginPath()
  context.moveTo(segment.from.x * width, segment.from.y * height)
  context.lineTo(segment.to.x * width, segment.to.y * height)
  context.stroke()
  context.restore()
}

function applyCanvasActionToCanvas(canvas, segment) {
  if (segment?.kind === 'fill') {
    floodFillCanvas(canvas, segment)
    return
  }

  drawStrokeOnCanvas(canvas, segment)
}

function repaintCanvasElement(canvas, segments) {
  clearCanvasElement(canvas)
  segments.forEach((segment) => applyCanvasActionToCanvas(canvas, segment))
}

function App() {
  const [nickname, setNickname] = useState('')
  const [roomCode, setRoomCode] = useState(initialRoomCode)
  const [draftMessage, setDraftMessage] = useState('')
  const [game, setGame] = useState(emptyGame)
  const [joinError, setJoinError] = useState('')
  const [connectionLabel, setConnectionLabel] = useState('오프라인')
  const [brushColor, setBrushColor] = useState(PALETTE[0])
  const [brushSize, setBrushSize] = useState(BRUSHES[1])
  const [toolMode, setToolMode] = useState('draw')
  const [copied, setCopied] = useState(false)

  const socketRef = useRef(null)
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const messagesRef = useRef(null)
  const drawingRef = useRef(false)
  const previousPointRef = useRef(null)
  const segmentsRef = useRef([])

  const joined = Boolean(game.roomCode)
  const canDraw = joined && game.phase === 'drawing' && game.drawerId === game.meId
  const resultTone = getResultTone(game)
  const shareUrl = game.roomCode
    ? `${window.location.origin}${window.location.pathname}?room=${game.roomCode}`
    : `${window.location.origin}${window.location.pathname}`

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!game.messages.length || !messagesRef.current) {
      return
    }

    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [game.messages])

  useEffect(() => {
    if (!joined) {
      return undefined
    }

    const syncCanvas = () => {
      const canvas = canvasRef.current
      const stage = stageRef.current

      if (!canvas || !stage) {
        return
      }

      const ratio = window.devicePixelRatio || 1
      const width = stage.clientWidth
      const height = stage.clientHeight
      const context = canvas.getContext('2d')

      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.save()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.restore()
      repaintCanvasElement(canvas, segmentsRef.current)
    }

    const observer = new ResizeObserver(() => {
      syncCanvas()
    })

    if (stageRef.current) {
      observer.observe(stageRef.current)
    }

    syncCanvas()

    return () => observer.disconnect()
  }, [joined])

  function attachSocket(socket) {
    socket.on('connect', () => {
      setConnectionLabel('연결됨')
      setJoinError('')
    })

    socket.on('disconnect', () => {
      setConnectionLabel('연결 끊김')
    })

    socket.on('connect_error', () => {
      setConnectionLabel('연결 실패')
      setJoinError('서버에 연결할 수 없습니다. 로컬 서버를 먼저 실행해 주세요.')
    })

    socket.on('joinError', (message) => {
      setJoinError(message)
    })

    socket.on('roomState', (nextState) => {
      setGame(nextState)
      setJoinError('')
      window.history.replaceState({}, '', `?room=${nextState.roomCode}`)
    })

    socket.on('canvasState', (segments) => {
      segmentsRef.current = Array.isArray(segments) ? segments : []
      repaintCanvasElement(canvasRef.current, segmentsRef.current)
    })

    socket.on('canvasAction', (segment) => {
      segmentsRef.current = [...segmentsRef.current, segment]
      applyCanvasActionToCanvas(canvasRef.current, segment)
    })
  }

  function connectAndJoin(event) {
    event.preventDefault()

    const cleanNickname = nickname.trim()
    const cleanRoomCode = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)

    if (!cleanNickname) {
      setJoinError('닉네임을 입력해 주세요.')
      return
    }

    if (!cleanRoomCode) {
      setJoinError('방 코드를 확인해 주세요.')
      return
    }

    socketRef.current?.disconnect()
    segmentsRef.current = []
    setGame(emptyGame)

    const socket = io(getServerUrl(), {
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket
    attachSocket(socket)
    socket.emit('joinRoom', {
      nickname: cleanNickname,
      roomCode: cleanRoomCode,
    })
  }

  function handleShare() {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  function handleMessageSubmit(event) {
    event.preventDefault()

    if (!draftMessage.trim()) {
      return
    }

    socketRef.current?.emit('sendMessage', draftMessage)
    setDraftMessage('')
  }

  function buildPoint(event) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()

    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    }
  }

  function handlePointerDown(event) {
    if (!canDraw) {
      return
    }

    if (toolMode === 'fill') {
      const segment = {
        kind: 'fill',
        point: buildPoint(event),
        color: brushColor,
      }

      segmentsRef.current = [...segmentsRef.current, segment]
      applyCanvasActionToCanvas(canvasRef.current, segment)
      socketRef.current?.emit('canvasAction', segment)
      return
    }

    drawingRef.current = true
    previousPointRef.current = buildPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event) {
    if (!drawingRef.current || !canDraw) {
      return
    }

    const nextPoint = buildPoint(event)
    const previousPoint = previousPointRef.current

    if (!previousPoint || (previousPoint.x === nextPoint.x && previousPoint.y === nextPoint.y)) {
      return
    }

    const segment = {
      kind: 'stroke',
      from: previousPoint,
      to: nextPoint,
      color: brushColor,
      size: brushSize,
      mode: toolMode,
    }

    segmentsRef.current = [...segmentsRef.current, segment]
    applyCanvasActionToCanvas(canvasRef.current, segment)
    socketRef.current?.emit('canvasAction', segment)
    previousPointRef.current = nextPoint
  }

  function handlePointerUp(event) {
    if (drawingRef.current) {
      drawingRef.current = false
      previousPointRef.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Guild Drawing Party</p>
          <h1>CatchButter</h1>
          <p className="hero-copy">
            오늘 2시간 정도 가볍게 놀기 좋은, 모바일 우선 실시간 그림 맞히기 프로토타입입니다.
          </p>
        </div>

        {!joined ? (
          <form className="join-panel" onSubmit={connectAndJoin}>
            <label>
              닉네임
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="길드 닉네임"
                maxLength={14}
              />
            </label>
            <label>
              방 코드
              <div className="room-code-row">
                <input
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={6}
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setRoomCode(Math.random().toString(36).slice(2, 8).toUpperCase())}
                >
                  새 코드
                </button>
              </div>
            </label>

            <button type="submit" className="primary-button">
              방 입장
            </button>
            <p className="muted-line">상태: {connectionLabel}</p>
            {joinError ? <p className="error-line">{joinError}</p> : null}
          </form>
        ) : (
          <div className="room-summary">
            <div>
              <span className="summary-label">Room</span>
              <strong>{game.roomCode}</strong>
            </div>
            <div>
              <span className="summary-label">Status</span>
              <strong>{getPhaseLabel(game.phase)}</strong>
            </div>
            <div>
              <span className="summary-label">Timer</span>
              <strong>{game.timeLeft}s</strong>
            </div>
            <button type="button" className="ghost-button" onClick={handleShare}>
              {copied ? '링크 복사됨' : '초대 링크 복사'}
            </button>
          </div>
        )}
      </section>

      {joined ? (
        <section className="game-grid">
          <article className="board-card">
            <header className="board-header">
              <div>
                <p className="eyebrow">Round {game.round || 0} / {game.maxRounds}</p>
                <h2>{game.answer || '준비 중'}</h2>
              </div>
              <div className="pill-group">
                <span className="status-pill">{game.drawerName} 그림 차례</span>
              </div>
            </header>

            <div className={`result-banner ${resultTone}`}>
              <strong>{game.phase === 'round-end' && game.resultText.includes('정답!') ? '정답 맞힘' : '안내'}</strong>
              <span>{game.resultText}</span>
            </div>

            <div className="canvas-stage" ref={stageRef}>
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
              {!canDraw ? <div className="canvas-overlay">정답을 맞히거나 채팅으로 분위기를 띄워보세요.</div> : null}
            </div>

            <div className="toolbar-card">
              <div className="toolbar-section">
                <div className="tool-row compact">
                  <span className="tool-label">도구</span>
                  <span className="tool-hint">출제자만 사용 가능</span>
                </div>
                <div className="tool-chip-grid">
                  <button
                    type="button"
                    className={toolMode === 'draw' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('draw')}
                    disabled={!canDraw}
                  >
                    펜
                  </button>
                  <button
                    type="button"
                    className={toolMode === 'fill' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('fill')}
                    disabled={!canDraw}
                  >
                    채우기
                  </button>
                  <button
                    type="button"
                    className={toolMode === 'erase' ? 'tool-button active' : 'tool-button'}
                    onClick={() => setToolMode('erase')}
                    disabled={!canDraw}
                  >
                    지우개
                  </button>
                  <button
                    type="button"
                    className="tool-button"
                    onClick={() => socketRef.current?.emit('clearCanvas')}
                    disabled={!canDraw}
                  >
                    전체 지우기
                  </button>
                </div>
              </div>

              <div className="toolbar-section">
                <div className="tool-row compact">
                  <span className="tool-label">색상</span>
                  <span className="tool-hint">{PALETTE.length}가지</span>
                </div>
                <div className="palette-grid">
                  {PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={brushColor === color ? 'color-chip active' : 'color-chip'}
                      style={{ backgroundColor: color }}
                      onClick={() => setBrushColor(color)}
                      disabled={!canDraw}
                      aria-label={`색상 ${color}`}
                    />
                  ))}
                </div>
              </div>

              <div className="toolbar-section">
                <div className="tool-row compact">
                  <span className="tool-label">굵기</span>
                  <span className="tool-hint">현재 {brushSize}px</span>
                </div>
                <div className="size-grid">
                  {BRUSHES.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={brushSize === size ? 'size-chip active' : 'size-chip'}
                      onClick={() => setBrushSize(size)}
                      disabled={!canDraw}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </article>

          <article className="panel-card chat-card">
            <div className="panel-header">
              <h3>채팅 / 정답</h3>
              <span className="muted-line">{connectionLabel}</span>
            </div>

            <div className="message-list" ref={messagesRef}>
              {game.messages.map((message) => (
                <div key={message.id} className={`message-bubble ${message.type}`}>
                  <strong>{message.sender}</strong>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>

            <form className="chat-form" onSubmit={handleMessageSubmit}>
              <input
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder={canDraw ? '채팅으로 힌트를 주지는 마세요' : '정답 또는 채팅 입력'}
                maxLength={80}
              />
              <button type="submit" className="primary-button">
                전송
              </button>
            </form>
          </article>

          <article className="panel-card player-card">
            <div className="panel-header">
              <h3>플레이어</h3>
              {game.canStart ? (
                <button type="button" className="primary-button" onClick={() => socketRef.current?.emit('startGame')}>
                  게임 시작
                </button>
              ) : null}
            </div>

            {game.isHost && game.phase === 'lobby' ? (
              <div className="round-config-card">
                <div className="tool-row compact">
                  <span className="tool-label">총 라운드 수</span>
                  <span className="tool-hint">시작 전 호스트만 변경 가능</span>
                </div>
                <div className="round-option-grid">
                  {ROUND_OPTIONS.map((roundOption) => (
                    <button
                      key={roundOption}
                      type="button"
                      className={game.maxRounds === roundOption ? 'size-chip active' : 'size-chip'}
                      onClick={() => socketRef.current?.emit('setMaxRounds', roundOption)}
                    >
                      {roundOption}R
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <ul className="player-list">
              {game.players.map((player) => (
                <li key={player.id} className={player.isMe ? 'player-row self' : 'player-row'}>
                  <div>
                    <strong>{player.nickname}</strong>
                    <span>
                      {player.isHost ? '호스트' : '플레이어'}
                      {player.id === game.drawerId ? ' · 그리는 중' : ''}
                    </span>
                  </div>
                  <b>{player.score}</b>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}
    </main>
  )
}

export default App
