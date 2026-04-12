import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

import { WORDS } from './words.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '0.0.0.0'
const WORD_CHOICE_DURATION_MS = 15_000
const INTERMISSION_MS = 4_000
const MIN_ROUNDS = 2
const DEFAULT_ROUNDS = 6
const ROUND_OPTIONS = [2, 3, 4, 5, 6, 8, 10]
const MAX_ROUNDS = ROUND_OPTIONS[ROUND_OPTIONS.length - 1] || DEFAULT_ROUNDS
const MAX_MESSAGES = 40
const MAX_CANVAS_SEGMENTS = 3000
const CORRECT_GUESS_POINTS = 60
const DRAWER_CORRECT_BONUS = 30
const rooms = new Map()
const UNIQUE_WORDS = Array.from(new Set(WORDS))

if (UNIQUE_WORDS.length !== WORDS.length) {
  console.warn(`[words] Duplicate entries removed at runtime: ${WORDS.length - UNIQUE_WORDS.length}`)
}

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_request, response) => {
  response.json({ ok: true, rooms: rooms.size })
})

const clientDistPath = path.resolve(__dirname, '../client/dist')
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))
  app.get(/^(?!\/socket\.io).*/, (_request, response) => {
    response.sendFile(path.join(clientDistPath, 'index.html'))
  })
}

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
})

function sanitizeNickname(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14)
}

function sanitizeRoomCode(value) {
  const cleaned = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)

  return cleaned || Math.random().toString(36).slice(2, 8).toUpperCase()
}

function createMessage(type, sender, text) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    sender,
    text,
    createdAt: Date.now(),
  }
}

function createWordDeck() {
  const deck = [...UNIQUE_WORDS]

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]]
  }

  return deck
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim()
}

function maskWord(word) {
  return Array.from(word || '')
    .map((character) => (character.trim() ? '●' : ' '))
    .join('')
}

function pickWord(room) {
  if (!room.wordDeck.length) {
    room.wordDeck = createWordDeck()
  }

  return room.wordDeck.pop() || UNIQUE_WORDS[0] || '정답'
}

function pickWordChoices(room, count = 3) {
  const choices = []
  const usedWords = new Set()
  const targetCount = Math.max(1, Math.min(Number(count) || 1, UNIQUE_WORDS.length || 1))
  const attemptLimit = Math.max(targetCount * 4, UNIQUE_WORDS.length * 2)
  let attempts = 0

  while (choices.length < targetCount && attempts < attemptLimit) {
    attempts += 1
    const nextWord = pickWord(room)

    if (usedWords.has(nextWord)) {
      continue
    }

    usedWords.add(nextWord)
    choices.push(nextWord)
  }

  if (choices.length < targetCount) {
    for (const fallbackWord of createWordDeck()) {
      if (choices.length >= targetCount) {
        break
      }

      if (usedWords.has(fallbackWord)) {
        continue
      }

      usedWords.add(fallbackWord)
      choices.push(fallbackWord)
    }
  }

  return choices
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      code: roomCode,
      hostId: null,
      drawerId: null,
      phase: 'lobby',
      round: 0,
      maxRounds: DEFAULT_ROUNDS,
      timeLeft: 0,
      word: null,
      wordChoices: [],
      resultText: '호스트가 게임을 시작하면 라운드가 열립니다.',
      messages: [createMessage('system', '시스템', '방이 열렸습니다. 플레이어를 기다리는 중입니다.')],
      segments: [],
      chooseEndsAt: null,
      roundEndsAt: null,
      nextRoundAt: null,
      wordDeck: createWordDeck(),
      correctGuesserIds: new Set(),
      skipVotes: new Set(),
      players: [],
    })
  }

  return rooms.get(roomCode)
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null
}

function pushMessage(room, type, sender, text) {
  room.messages.push(createMessage(type, sender, text))
  room.messages = room.messages.slice(-MAX_MESSAGES)
}

function pushSystemMessage(room, text) {
  pushMessage(room, 'system', '시스템', text)
}

function pushCorrectMessage(room, winner) {
  pushMessage(room, 'correct', '정답', `${winner} 님이 정답을 맞혔습니다!`)
}

function pushChatMessage(room, sender, text) {
  pushMessage(room, 'chat', sender, text)
}

function getSkipVotesNeeded(room) {
  return room.players.filter((player) => player.id !== room.drawerId).length
}

function getGuessersNeeded(room) {
  return room.players.filter((player) => player.id !== room.drawerId).length
}

function resetRoundProgress(room) {
  room.correctGuesserIds.clear()
  room.skipVotes.clear()
}

function updateDrawingStatus(room, latestCorrectPlayer = null) {
  const skipVotesNeeded = getSkipVotesNeeded(room)
  const skipVotesCount = room.skipVotes.size
  const correctCount = room.correctGuesserIds.size
  const guessersNeeded = getGuessersNeeded(room)

  if (correctCount > 0) {
    const correctLead =
      correctCount === 1 && latestCorrectPlayer
        ? `${latestCorrectPlayer.nickname} 님이 정답을 맞혔습니다.`
        : `현재 ${correctCount}명이 정답을 맞혔습니다.`

    const completionHint =
      correctCount >= guessersNeeded && guessersNeeded > 0
        ? '모든 참가자가 정답을 맞혀 곧 다음 라운드로 넘어갑니다.'
        : `그림은 계속 진행됩니다. 넘기기 ${skipVotesCount}/${skipVotesNeeded}`

    room.resultText = `${correctLead} ${completionHint}`
    return
  }

  room.resultText = `시간 제한 없이 진행 중입니다. 넘기기 ${skipVotesCount}/${skipVotesNeeded}`
}

function serializeRoomForPlayer(room, playerId) {
  const me = getPlayer(room, playerId)
  const drawer = getPlayer(room, room.drawerId)
  const hasGuessedCorrectly = room.correctGuesserIds.has(playerId)
  const revealAnswer = room.phase === 'round-end' || playerId === room.drawerId || hasGuessedCorrectly
  const answer =
    room.phase === 'choosing'
      ? playerId === room.drawerId
        ? '단어를 골라 주세요'
        : '출제자가 단어를 고르는 중'
      : revealAnswer
        ? room.word
        : maskWord(room.word)

  return {
    meId: playerId,
    roomCode: room.code,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    timeLeft: room.timeLeft,
    answer,
    wordChoices: playerId === room.drawerId ? room.wordChoices : [],
    resultText: room.resultText,
    drawerId: room.drawerId,
    drawerName: drawer?.nickname || '대기 중',
    isHost: room.hostId === playerId,
    canStart: room.hostId === playerId && room.phase === 'lobby' && room.players.length >= 2,
    hasGuessedCorrectly,
    guessedCount: room.correctGuesserIds.size,
    canVoteSkip: room.phase === 'drawing' && playerId !== room.drawerId,
    canFinishRound: room.phase === 'drawing' && playerId === room.drawerId,
    hasSkipVoted: room.skipVotes.has(playerId),
    skipVotesCount: room.skipVotes.size,
    skipVotesNeeded: getSkipVotesNeeded(room),
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      isHost: player.id === room.hostId,
      isMe: player.id === me?.id,
    })),
    messages: room.messages,
  }
}

function emitRoomState(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit('roomState', serializeRoomForPlayer(room, player.id))
  })
}

function emitRoomTick(room) {
  const payload = {
    phase: room.phase,
    timeLeft: room.timeLeft,
  }

  room.players.forEach((player) => {
    io.to(player.id).emit('roomTick', payload)
  })
}

function emitCanvasState(room) {
  io.to(room.code).emit('canvasState', room.segments)
}

function resetToLobby(room, message) {
  room.phase = 'lobby'
  room.round = 0
  room.drawerId = null
  room.word = null
  room.wordChoices = []
  room.timeLeft = 0
  room.resultText = message || '호스트가 게임을 시작하면 라운드가 열립니다.'
  room.segments = []
  room.chooseEndsAt = null
  room.roundEndsAt = null
  room.nextRoundAt = null
  room.wordDeck = createWordDeck()
  resetRoundProgress(room)
  emitCanvasState(room)
  emitRoomState(room)
}

function concludeGame(room) {
  const sortedPlayers = [...room.players].sort((left, right) => right.score - left.score)
  const winner = sortedPlayers[0]
  pushSystemMessage(
    room,
    winner
      ? `게임 종료. 우승자는 ${winner.nickname} (${winner.score}점) 입니다.`
      : '게임 종료. 플레이어가 없습니다.',
  )
  resetToLobby(room, winner ? `${winner.nickname} 님이 최종 우승했습니다.` : '플레이어가 사라져 게임이 종료됐습니다.')
}

function beginRound(room) {
  if (room.players.length < 2) {
    resetToLobby(room, '플레이어가 2명 이상 있어야 게임을 시작할 수 있습니다.')
    return
  }

  if (room.round >= room.maxRounds) {
    concludeGame(room)
    return
  }

  const currentDrawerIndex = room.players.findIndex((player) => player.id === room.drawerId)
  const nextDrawerIndex = currentDrawerIndex >= 0 ? (currentDrawerIndex + 1) % room.players.length : 0
  const nextDrawer = room.players[nextDrawerIndex]

  room.round += 1
  room.drawerId = nextDrawer.id
  room.word = null
  room.wordChoices = pickWordChoices(room)
  room.phase = 'choosing'
  room.timeLeft = Math.ceil(WORD_CHOICE_DURATION_MS / 1000)
  room.resultText = `${nextDrawer.nickname} 님이 단어를 고르는 중입니다.`
  room.segments = []
  room.chooseEndsAt = Date.now() + WORD_CHOICE_DURATION_MS
  room.roundEndsAt = null
  room.nextRoundAt = null
  resetRoundProgress(room)

  pushSystemMessage(room, `라운드 ${room.round} 시작. ${nextDrawer.nickname} 님이 단어를 고르는 중입니다.`)
  emitCanvasState(room)
  emitRoomState(room)
}

function startDrawingPhase(room, chosenWord) {
  const drawer = getPlayer(room, room.drawerId)

  room.word = chosenWord
  room.wordChoices = []
  room.phase = 'drawing'
  room.timeLeft = null
  room.chooseEndsAt = null
  room.roundEndsAt = null
  resetRoundProgress(room)
  updateDrawingStatus(room)

  pushSystemMessage(room, `제시어가 선택됐습니다. ${drawer?.nickname || '출제자'} 님이 시간 제한 없이 그림을 그립니다.`)
  emitRoomState(room)
}

function registerCorrectGuess(room, winnerId) {
  if (room.phase !== 'drawing' || room.correctGuesserIds.has(winnerId) || room.drawerId === winnerId) {
    return
  }

  const winner = getPlayer(room, winnerId)
  const drawer = getPlayer(room, room.drawerId)

  if (!winner || !drawer) {
    return
  }

  room.correctGuesserIds.add(winner.id)
  winner.score += CORRECT_GUESS_POINTS
  drawer.score += DRAWER_CORRECT_BONUS

  pushCorrectMessage(room, winner.nickname)

  if (getGuessersNeeded(room) > 0 && room.correctGuesserIds.size >= getGuessersNeeded(room)) {
    finishRound(room, 'all-correct')
    return
  }

  updateDrawingStatus(room, winner)
  emitRoomState(room)
}

function finishRound(room, reason) {
  if (room.phase !== 'drawing') {
    return
  }

  room.phase = 'round-end'
  room.timeLeft = 0
  room.roundEndsAt = null
  room.nextRoundAt = Date.now() + INTERMISSION_MS
  room.resultText =
    reason === 'drawer-left'
        ? `그리는 사람이 나가서 라운드가 종료됐습니다. 제시어는 \"${room.word}\"였습니다.`
        : reason === 'drawer-skip'
          ? `출제자가 다음 라운드로 넘겼습니다. 제시어는 \"${room.word}\"였습니다.`
        : reason === 'all-correct'
          ? `모든 참가자가 정답을 맞혀 다음 라운드로 넘어갑니다. 제시어는 \"${room.word}\"였습니다.`
        : reason === 'skip-vote'
          ? `모든 참가자가 넘기기에 동의해 다음 라운드로 넘어갑니다. 제시어는 \"${room.word}\"였습니다.`
          : `라운드가 종료됐습니다. 제시어는 \"${room.word}\"였습니다.`

  pushSystemMessage(room, room.resultText)
  emitRoomState(room)
}

function setSkipVote(room, playerId, shouldSkip) {
  if (room.phase !== 'drawing' || room.drawerId === playerId) {
    return
  }

  if (shouldSkip) {
    room.skipVotes.add(playerId)
  } else {
    room.skipVotes.delete(playerId)
  }

  const skipVotesNeeded = getSkipVotesNeeded(room)

  if (skipVotesNeeded > 0 && room.skipVotes.size >= skipVotesNeeded) {
    finishRound(room, 'skip-vote')
    return
  }

  updateDrawingStatus(room)
  emitRoomState(room)
}

function finishRoundByDrawer(room, playerId) {
  if (room.phase !== 'drawing' || room.drawerId !== playerId) {
    return
  }

  finishRound(room, 'drawer-skip')
}

function startGame(room) {
  room.players.forEach((player) => {
    player.score = 0
  })

  room.messages = room.messages.slice(-10)
  room.round = 0
  room.drawerId = null
  room.resultText = '새 게임을 준비 중입니다.'
  room.wordDeck = createWordDeck()
  beginRound(room)
}

function validateCanvasAction(action) {
  if (!action || typeof action !== 'object') {
    return false
  }

  if (action.kind === 'fill') {
    const point = action.point

    return (
      point &&
      typeof point.x === 'number' &&
      typeof point.y === 'number' &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1 &&
      typeof action.color === 'string'
    )
  }

  const points = [action.from, action.to]
  const hasValidPoints = points.every(
    (point) =>
      point &&
      typeof point.x === 'number' &&
      typeof point.y === 'number' &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1,
  )

  if (!hasValidPoints) {
    return false
  }

  return ['draw', 'erase'].includes(action.mode) && typeof action.size === 'number'
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (payload = {}) => {
    const nickname = sanitizeNickname(payload.nickname)
    const roomCode = sanitizeRoomCode(payload.roomCode)

    if (!nickname) {
      socket.emit('joinError', '닉네임을 입력해 주세요.')
      return
    }

    const room = getRoom(roomCode)
    socket.join(room.code)
    room.players.push({
      id: socket.id,
      nickname,
      score: 0,
    })

    if (!room.hostId) {
      room.hostId = socket.id
    }

    socket.data.roomCode = room.code
    pushSystemMessage(room, `${nickname} 님이 입장했습니다.`)
    emitRoomState(room)
    socket.emit('canvasState', room.segments)
  })

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode)

    if (!room || room.hostId !== socket.id || room.players.length < 2) {
      return
    }

    startGame(room)
  })

  socket.on('chooseWord', (word) => {
    const room = rooms.get(socket.data.roomCode)

    if (!room || room.drawerId !== socket.id || room.phase !== 'choosing') {
      return
    }

    const chosenWord = room.wordChoices.find((candidate) => candidate === word)

    if (!chosenWord) {
      return
    }

    startDrawingPhase(room, chosenWord)
  })

  socket.on('setMaxRounds', (nextValue, callback) => {
    const room = rooms.get(socket.data.roomCode)

    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') {
      callback?.({ ok: false, message: '로비에서 호스트만 라운드 수를 바꿀 수 있습니다.' })
      return
    }

    const parsedValue = Number(nextValue)

    if (!ROUND_OPTIONS.includes(parsedValue)) {
      callback?.({ ok: false, message: '지원하지 않는 라운드 수입니다.' })
      return
    }

    room.maxRounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, parsedValue))
    room.resultText = `호스트가 총 ${room.maxRounds}라운드로 설정했습니다.`
    emitRoomState(room)
    callback?.({ ok: true, maxRounds: room.maxRounds })
  })

  socket.on('sendMessage', (rawText) => {
    const room = rooms.get(socket.data.roomCode)
    const player = room ? getPlayer(room, socket.id) : null
    const text = String(rawText || '').trim().slice(0, 80)

    if (!room || !player || !text) {
      return
    }

    if (room.phase === 'drawing' && socket.id !== room.drawerId && normalizeText(text) === normalizeText(room.word)) {
      registerCorrectGuess(room, socket.id)
      return
    }

    pushChatMessage(room, player.nickname, text)
    emitRoomState(room)
  })

  socket.on('setSkipVote', (shouldSkip) => {
    const room = rooms.get(socket.data.roomCode)

    if (!room) {
      return
    }

    setSkipVote(room, socket.id, Boolean(shouldSkip))
  })

  socket.on('finishRound', () => {
    const room = rooms.get(socket.data.roomCode)

    if (!room) {
      return
    }

    finishRoundByDrawer(room, socket.id)
  })

  socket.on('canvasAction', (action) => {
    const room = rooms.get(socket.data.roomCode)

    if (!room || room.phase !== 'drawing' || room.drawerId !== socket.id || !validateCanvasAction(action)) {
      return
    }

    const sanitizedSegment =
      action.kind === 'fill'
        ? {
            kind: 'fill',
            point: action.point,
            color: typeof action.color === 'string' ? action.color.slice(0, 20) : '#101418',
          }
        : {
            kind: 'stroke',
            from: action.from,
            to: action.to,
            color: typeof action.color === 'string' ? action.color.slice(0, 20) : '#101418',
            size: Math.max(2, Math.min(24, Number(action.size) || 6)),
            mode: action.mode,
          }

    room.segments.push(sanitizedSegment)

    if (room.segments.length > MAX_CANVAS_SEGMENTS) {
      room.segments.splice(0, room.segments.length - MAX_CANVAS_SEGMENTS)
    }

    socket.to(room.code).emit('canvasAction', sanitizedSegment)
  })

  socket.on('clearCanvas', () => {
    const room = rooms.get(socket.data.roomCode)

    if (!room || room.drawerId !== socket.id) {
      return
    }

    room.segments = []
    emitCanvasState(room)
  })

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode)

    if (!room) {
      return
    }

    const leavingPlayer = getPlayer(room, socket.id)
    room.players = room.players.filter((player) => player.id !== socket.id)
    room.correctGuesserIds.delete(socket.id)
    room.skipVotes.delete(socket.id)

    if (!room.players.length) {
      rooms.delete(room.code)
      return
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id
    }

    if (leavingPlayer) {
      pushSystemMessage(room, `${leavingPlayer.nickname} 님이 퇴장했습니다.`)
    }

    if (room.drawerId === socket.id && room.phase === 'choosing') {
      room.round -= 1
      beginRound(room)
      return
    }

    if (room.drawerId === socket.id && room.phase === 'drawing') {
      finishRound(room, 'drawer-left')
      return
    }

    if (room.players.length < 2 && room.phase !== 'lobby') {
      resetToLobby(room, '플레이어 수가 부족해 로비로 돌아갑니다.')
      return
    }

    if (room.phase === 'drawing' && getSkipVotesNeeded(room) > 0 && room.skipVotes.size >= getSkipVotesNeeded(room)) {
      finishRound(room, 'skip-vote')
      return
    }

    if (room.phase === 'drawing' && getGuessersNeeded(room) > 0 && room.correctGuesserIds.size >= getGuessersNeeded(room)) {
      finishRound(room, 'all-correct')
      return
    }

    if (room.phase === 'drawing') {
      updateDrawingStatus(room)
    }

    emitRoomState(room)
  })
})

setInterval(() => {
  const now = Date.now()

  rooms.forEach((room) => {
    if (room.phase === 'choosing' && room.chooseEndsAt) {
      const nextTimeLeft = Math.max(0, Math.ceil((room.chooseEndsAt - now) / 1000))

      if (nextTimeLeft !== room.timeLeft) {
        room.timeLeft = nextTimeLeft
        emitRoomTick(room)
      }

      if (room.chooseEndsAt <= now) {
        startDrawingPhase(room, room.wordChoices[0] || pickWord(room))
      }
    }

    if (room.phase === 'round-end' && room.nextRoundAt && room.nextRoundAt <= now) {
      beginRound(room)
    }
  })
}, 500)

function getNetworkUrls(port) {
  const interfaces = os.networkInterfaces()
  const urls = []

  Object.values(interfaces).forEach((networkInterface) => {
    networkInterface?.forEach((details) => {
      if (details.family === 'IPv4' && !details.internal) {
        urls.push(`http://${details.address}:${port}`)
      }
    })
  })

  return urls
}

function handleServerError(error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or set a different PORT.`)
    console.error(`Windows example: set PORT=3002 && npm run start`)
    process.exit(1)
  }

  if (error.code === 'EACCES') {
    console.error(`Permission denied while binding to ${HOST}:${PORT}. Try a higher port or run with sufficient privileges.`)
    process.exit(1)
  }

  console.error('Server failed to start.', error)
  process.exit(1)
}

httpServer.on('error', handleServerError)

httpServer.listen(PORT, HOST, () => {
  console.log('CatchButter server listening')
  console.log(`Local:   http://localhost:${PORT}`)

  getNetworkUrls(PORT).forEach((url) => {
    console.log(`Network: ${url}`)
  })
})