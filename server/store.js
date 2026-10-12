const crypto = require('node:crypto');

const DEFAULT_ZONE_NAME = 'Grupo principal';

function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const byte of crypto.randomBytes(6)) code += alphabet[byte % alphabet.length];
  return code;
}

function createStore(db) {
  const q = {
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'),
    userById: db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash FROM users WHERE username = ?'),

    insertRoom: db.prepare('INSERT INTO rooms (name, description, master_id, invite_code) VALUES (?, ?, ?, ?)'),
    roomById: db.prepare(`
      SELECT r.id, r.name, r.description, r.invite_code AS inviteCode, r.master_id AS masterId,
             u.display_name AS masterName
      FROM rooms r JOIN users u ON u.id = r.master_id WHERE r.id = ?`),
    roomByCode: db.prepare('SELECT id, master_id AS masterId FROM rooms WHERE invite_code = ?'),
    roomsForUser: db.prepare(`
      SELECT r.id, r.name, r.description, r.master_id AS masterId, u.display_name AS masterName,
             CASE WHEN r.master_id = ? THEN r.invite_code END AS inviteCode,
             (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS playerCount
      FROM rooms r JOIN users u ON u.id = r.master_id
      WHERE r.master_id = ? OR r.id IN (SELECT room_id FROM room_members WHERE user_id = ?)
      ORDER BY r.created_at DESC, r.id DESC`),
    deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),

    insertZone: db.prepare('INSERT INTO zones (room_id, name, position) VALUES (?, ?, ?)'),
    zonesForRoom: db.prepare('SELECT id, name, position FROM zones WHERE room_id = ? ORDER BY position, id'),
    renameZone: db.prepare('UPDATE zones SET name = ? WHERE id = ? AND room_id = ?'),
    deleteZone: db.prepare('DELETE FROM zones WHERE id = ? AND room_id = ?'),
    maxZonePosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS pos FROM zones WHERE room_id = ?'),

    insertMember: db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, zone_id) VALUES (?, ?, ?)'),
    member: db.prepare('SELECT zone_id AS zoneId FROM room_members WHERE room_id = ? AND user_id = ?'),
    membersForRoom: db.prepare(`
      SELECT u.id, u.display_name AS displayName, m.zone_id AS zoneId
      FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ? ORDER BY u.display_name COLLATE NOCASE`),
    setMemberZone: db.prepare('UPDATE room_members SET zone_id = ? WHERE room_id = ? AND user_id = ?'),
    moveZoneMembers: db.prepare('UPDATE room_members SET zone_id = ? WHERE room_id = ? AND (zone_id = ? OR zone_id IS NULL)'),
    deleteMember: db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?'),
  };

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    createUser({ username, displayName, passwordHash, role }) {
      const { lastInsertRowid } = q.insertUser.run(username, displayName, passwordHash, role);
      return q.userById.get(Number(lastInsertRowid));
    },
    getUser: (id) => q.userById.get(id),
    getUserWithPassword: (username) => q.userByName.get(username),

    createRoom({ name, description, masterId }) {
      return transaction(() => {
        let roomId;
        for (let attempt = 0; ; attempt++) {
          try {
            roomId = Number(q.insertRoom.run(name, description, masterId, generateInviteCode()).lastInsertRowid);
            break;
          } catch (err) {
            if (attempt >= 5 || !/UNIQUE/.test(err.message)) throw err;
          }
        }
        q.insertZone.run(roomId, DEFAULT_ZONE_NAME, 0);
        return roomId;
      });
    },
    getRoom: (id) => q.roomById.get(id),
    getRoomByCode: (code) => q.roomByCode.get(code),
    listRoomsForUser: (userId) => q.roomsForUser.all(userId, userId, userId),
    deleteRoom: (id) => q.deleteRoom.run(id),

    listZones: (roomId) => q.zonesForRoom.all(roomId),
    createZone(roomId, name) {
      const pos = q.maxZonePosition.get(roomId).pos + 1;
      return Number(q.insertZone.run(roomId, name, pos).lastInsertRowid);
    },
    renameZone: (roomId, zoneId, name) => q.renameZone.run(name, zoneId, roomId).changes > 0,
    /** Remove um ambiente e manda quem estava nele para `fallbackZoneId`. */
    deleteZone(roomId, zoneId, fallbackZoneId) {
      return transaction(() => {
        q.moveZoneMembers.run(fallbackZoneId, roomId, zoneId);
        return q.deleteZone.run(zoneId, roomId).changes > 0;
      });
    },

    addMember(roomId, userId) {
      const firstZone = q.zonesForRoom.all(roomId)[0];
      q.insertMember.run(roomId, userId, firstZone ? firstZone.id : null);
    },
    getMembership: (roomId, userId) => q.member.get(roomId, userId),
    listMembers: (roomId) => q.membersForRoom.all(roomId),
    setMemberZone: (roomId, userId, zoneId) => q.setMemberZone.run(zoneId, roomId, userId),
    removeMember: (roomId, userId) => q.deleteMember.run(roomId, userId).changes > 0,
  };
}

module.exports = { createStore, DEFAULT_ZONE_NAME };
