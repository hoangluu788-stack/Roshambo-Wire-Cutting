const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Khởi tạo trạng thái phòng
function createRoomState(roomId) {
  return {
    roomId,
    players: {}, 
    spectators: {}, 
    gameState: 'WAITING', // WAITING, SETUP_DEADWIRE, BETTING, RPS, CUTTING, GAME_OVER
    cutWires: { p1: [], p2: [] },
    rpsChoices: {},
    turnWinner: null,
    winner: null,
    timer: 0,
    bets: { p1: 0, p2: 0 } // Tổng tiền cược của khán giả
  };
}

io.on('connection', (socket) => {

  // Lấy danh sách các phòng
  socket.on('getPublicRooms', () => {
    const publicList = Object.keys(rooms).map(id => ({
      id,
      p1: rooms[id].players.p1 ? rooms[id].players.p1.name : 'Trống',
      p2: rooms[id].players.p2 ? rooms[id].players.p2.name : 'Trống',
      spectators: Object.keys(rooms[id].spectators).length,
      state: rooms[id].gameState
    }));
    socket.emit('publicRoomsList', publicList);
  });

  // Tham gia phòng
  socket.on('joinRoom', ({ roomId, playerName, isPrivate }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = createRoomState(roomId);
    const room = rooms[roomId];

    let role = 'spectator';
    if (!room.players.p1) {
      role = 'p1';
      room.players.p1 = { id: socket.id, name: playerName || 'Player 1', role: 'p1', coins: 10000, deadWire: null };
    } else if (!room.players.p2) {
      role = 'p2';
      room.players.p2 = { id: socket.id, name: playerName || 'Player 2', role: 'p2', coins: 10000, deadWire: null };
    } else {
      room.spectators[socket.id] = { id: socket.id, name: playerName || 'Khán Giả', coins: 50000, betTarget: null, betAmount: 0 };
    }

    socket.emit('joined', { role, roomId, socketId: socket.id, coin: role !== 'spectator' ? room.players[role].coins : room.spectators[socket.id].coins });
    io.to(roomId).emit('roomState', room);

    // Khi đủ 2 người chơi -> Bắt đầu chọn dây tử thần
    if (room.players.p1 && room.players.p2 && room.gameState === 'WAITING') {
      room.gameState = 'SETUP_DEADWIRE';
      io.to(roomId).emit('roomState', room);
    }
  });

  // Chọn dây tử thần
  socket.on('setDeadWire', ({ roomId, wireIndex }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'SETUP_DEADWIRE') return;

    if (room.players.p1 && room.players.p1.id === socket.id) room.players.p1.deadWire = wireIndex;
    if (room.players.p2 && room.players.p2.id === socket.id) room.players.p2.deadWire = wireIndex;

    if (room.players.p1.deadWire !== null && room.players.p2.deadWire !== null) {
      startBettingPhase(room);
    }
  });

  // Chuyển sang giai đoạn Đặt cược khán giả (5 giây)
  function startBettingPhase(room) {
    room.gameState = 'BETTING';
    room.timer = 6;
    io.to(room.roomId).emit('roomState', room);

    const interval = setInterval(() => {
      room.timer--;
      io.to(room.roomId).emit('timerUpdate', room.timer);

      if (room.timer <= 0) {
        clearInterval(interval);
        startRPSPhase(room);
      }
    }, 1000);
  }

  // Khán giả đặt cược
  socket.on('placeBet', ({ roomId, target, amount }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'BETTING') return;
    const spec = room.spectators[socket.id];

    if (spec && spec.coins >= amount) {
      spec.coins -= amount;
      spec.betTarget = target; // 'p1' hoặc 'p2'
      spec.betAmount += amount;
      room.bets[target] += amount;

      socket.emit('coinUpdate', spec.coins);
      io.to(roomId).emit('roomState', room);
    }
  });

  // Bắt đầu Oẳn Tù Tì
  function startRPSPhase(room) {
    room.gameState = 'RPS';
    room.rpsChoices = {};
    io.to(room.roomId).emit('roomState', room);
  }

  // Người chơi ra đòn Oẳn tù tì
  socket.on('playRPS', ({ roomId, choice }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'RPS') return;

    if (room.players.p1 && room.players.p1.id === socket.id) room.rpsChoices.p1 = choice;
    if (room.players.p2 && room.players.p2.id === socket.id) room.rpsChoices.p2 = choice;

    if (room.rpsChoices.p1 && room.rpsChoices.p2) {
      const c1 = room.rpsChoices.p1;
      const c2 = room.rpsChoices.p2;

      if (c1 === c2) {
        room.rpsChoices = {};
        io.to(roomId).emit('rpsResult', { result: 'draw', message: '🤝 HÒA RỒI! Oẳn Tù Tì Lại...' });
      } else if (
        (c1 === 'rock' && c2 === 'scissors') ||
        (c1 === 'scissors' && c2 === 'paper') ||
        (c1 === 'paper' && c2 === 'rock')
      ) {
        room.turnWinner = 'p1';
        room.gameState = 'CUTTING';
        io.to(roomId).emit('rpsResult', { result: 'p1', message: '🎉 PLAYER 1 THẮNG LƯỢT này!' });
      } else {
        room.turnWinner = 'p2';
        room.gameState = 'CUTTING';
        io.to(roomId).emit('rpsResult', { result: 'p2', message: '🎉 PLAYER 2 THẮNG LƯỢT này!' });
      }
      io.to(roomId).emit('roomState', room);
    }
  });

  // Người thắng chọn cắt dây
  socket.on('cutWire', ({ roomId, wireIndex }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'CUTTING') return;

    const winnerPlayer = room.players[room.turnWinner];
    if (!winnerPlayer || winnerPlayer.id !== socket.id) return;

    const targetRole = room.turnWinner === 'p1' ? 'p2' : 'p1';
    const targetPlayer = room.players[targetRole];

    if (room.cutWires[targetRole].includes(wireIndex)) return;
    room.cutWires[targetRole].push(wireIndex);

    // Cắt trúng Dây Tử Thần -> Kết thúc trận đấu
    if (wireIndex === targetPlayer.deadWire) {
      room.gameState = 'GAME_OVER';
      room.winner = room.turnWinner;
      processPayouts(room);
    } else {
      startRPSPhase(room);
    }

    io.to(roomId).emit('roomState', room);
  });

  // Xử lý Trả Thưởng theo đúng Game Economics (Tính Phế 5%)
  function processPayouts(room) {
    const winnerRole = room.winner; // 'p1' hoặc 'p2'
    const TAX_RATE = 0.05; // Thuế 5%

    Object.keys(room.spectators).forEach(id => {
      const spec = room.spectators[id];
      if (spec.betTarget === winnerRole && spec.betAmount > 0) {
        // Đúng: Nhận 2X - Phế 5% lãi
        const profit = spec.betAmount * (1 - TAX_RATE);
        const reward = spec.betAmount + profit;
        spec.coins += reward;
        
        // Thưởng cho Người chơi thắng (0.5X cược)
        if (room.players[winnerRole]) {
          room.players[winnerRole].coins += spec.betAmount * 0.5;
        }

        io.to(id).emit('coinUpdate', spec.coins);
        io.to(id).emit('notification', `💰 Bạn đoán ĐÚNG! Nhận +$${reward.toLocaleString()} vàng.`);
      } else if (spec.betTarget && spec.betTarget !== winnerRole) {
        io.to(id).emit('notification', `❌ Bạn đoán SAI! Mất -$${spec.betAmount.toLocaleString()} vàng.`);
      }
    });
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server dang chay tai: http://localhost:${PORT}`);
});