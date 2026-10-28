// Ultimate English Universe — anonymous nickname + room-code multiplayer
// Replace these two values with your Supabase Project URL and Publishable key.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://crwbdrjukauddodmrphgq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4LGBcamtNZcnoEDGc_S_Iq7FBBym4T";
const configured = SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.startsWith("sb_publishable_");

const $ = (id) => document.getElementById(id);
let sb = null, room = null, player = null, token = null, isHost = false;
let roomSub = null, playerSub = null, currentQuestion = -1, answered = new Set(), players = [];
let busy = false;

function say(msg) { $("message").textContent = msg; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function makeToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function renderPlayers(list) {
  players = (list || []).slice().sort((a,b) => (b.xp || 0) - (a.xp || 0) || a.nickname.localeCompare(b.nickname));
  $("leaderboard").innerHTML = players.length ? players.map((p,i) =>
    `<div class="player"><div><strong>${i+1}. ${escapeHtml(p.nickname)}</strong><div class="small">${p.id===player?.id?"คุณ":p.is_host?"ผู้สร้างห้อง":"ผู้เล่น"}</div></div><div class="score">${Number(p.xp)||0} XP</div></div>`
  ).join("") : '<div class="status">ยังไม่มีผู้เล่นในห้อง</div>';
}
function setupClient() {
  if (!configured) { say("กรุณาตรวจค่า SUPABASE_URL และ SUPABASE_ANON_KEY ใน app.js"); return false; }
  if (!sb) sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { params: { eventsPerSecond: 10 } } });
  return true;
}
function setBusy(value) {
  busy = value;
  $("createBtn").disabled = value;
  $("joinBtn").disabled = value;
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
async function createRoom() {
  if (busy || !setupClient()) return;
  const nickname = $("nickname").value.trim();
  if (!nickname) { say("กรุณาใส่ชื่อเล่นก่อนค่ะ"); return; }
  setBusy(true);
  token = makeToken();
  try {
    const data = await rpc("ueu_create_room", { p_nickname: nickname, p_token: token, p_room_name: "English Battle" });
    const r = Array.isArray(data) ? data[0] : data;
    room = { id: r.room_id, room_code: r.room_code, room_name: "English Battle", status: "waiting", question_index: 0 };
    player = { id: r.player_id, nickname, xp: 0, is_host: true, room_id: room.id };
    isHost = true;
    sessionStorage.setItem("ueu_session", JSON.stringify({ token, roomId: room.id, playerId: player.id, isHost }));
    await enterRoom();
  } catch (e) { say("สร้างห้องไม่สำเร็จ: " + (e.message || e)); }
  finally { setBusy(false); }
}
async function joinRoom() {
  if (busy || !setupClient()) return;
  const nickname = $("nickname").value.trim();
  const code = $("roomInput").value.trim().toUpperCase();
  if (!nickname) { say("กรุณาใส่ชื่อเล่นก่อนค่ะ"); return; }
  if (!/^[A-Z0-9]{6}$/.test(code)) { say("รหัสห้องต้องมี 6 ตัวอักษร/ตัวเลข"); return; }
  setBusy(true);
  token = makeToken();
  try {
    const data = await rpc("ueu_join_room", { p_room_code: code, p_nickname: nickname, p_token: token });
    const r = Array.isArray(data) ? data[0] : data;
    room = { id: r.room_id, room_code: code, room_name: r.room_name, status: r.status, question_index: r.question_index };
    player = { id: r.player_id, nickname, xp: 0, is_host: false, room_id: room.id };
    isHost = false;
    sessionStorage.setItem("ueu_session", JSON.stringify({ token, roomId: room.id, playerId: player.id, isHost }));
    await enterRoom();
  } catch (e) { say("เข้าห้องไม่สำเร็จ: " + (e.message || e)); }
  finally { setBusy(false); }
}
async function enterRoom() {
  $("roomArea").classList.remove("hidden");
  $("joinArea").classList.add("hidden");
  $("roomCode").textContent = room.room_code;
  $("startBtn").classList.toggle("hidden", !isHost);
  $("roomStatus").textContent = isHost ? "คุณเป็นผู้สร้างห้อง สามารถเริ่มเกมได้เมื่อพร้อม" : "เข้าห้องแล้ว รอผู้สร้างห้องเริ่มการแข่งขัน";
  $("createBtn").disabled = true;
  $("showJoinBtn").disabled = true;
  $("joinBtn").disabled = true;
  say("เชื่อมต่อห้อง " + room.room_code + " แล้ว");
  await refreshPlayers();
  await syncRoom();
  const filter = `room_id=eq.${room.id}`;
  playerSub = sb.channel("ueu-players-" + room.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_players", filter }, () => refreshPlayers())
    .subscribe();
  roomSub = sb.channel("ueu-room-" + room.id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "game_rooms", filter: `id=eq.${room.id}` }, payload => {
      room = payload.new;
      syncRoom();
    }).subscribe();
}
async function refreshPlayers() {
  if (!room) return;
  const { data, error } = await sb.from("room_players").select("id,room_id,nickname,xp,is_host,joined_at").eq("room_id", room.id);
  if (error) { $("roomStatus").textContent = "อัปเดตรายชื่อไม่ได้: " + error.message; return; }
  renderPlayers(data || []);
}
async function syncRoom() {
  if (!room) return;
  if (room.status === "playing") {
    $("gameArea").classList.remove("hidden");
    $("finishedArea").classList.add("hidden");
    const index = Number(room.question_index || 0);
    if (index !== currentQuestion) {
      currentQuestion = index;
      await renderQuestion(index);
    }
  } else if (room.status === "finished") {
    $("gameArea").classList.add("hidden");
    $("finishedArea").classList.remove("hidden");
    const winner = players[0];
    $("winnerText").textContent = winner ? `ผู้ชนะ: ${winner.nickname} — ${winner.xp} XP` : "การแข่งขันจบแล้ว";
    $("roomStatus").textContent = "การแข่งขันจบแล้ว";
  } else {
    $("gameArea").classList.add("hidden");
    $("gameMessage").textContent = "รอผู้สร้างห้องเริ่มการแข่งขัน";
    $("roomStatus").textContent = `ห้อง ${room.room_code} · ${players.length} ผู้เล่น · รอเริ่ม`;
  }
}
async function startGame() {
  if (!isHost || !room || busy) return;
  setBusy(true);
  try { await rpc("ueu_start_game", { p_room_id: room.id, p_token: token }); }
  catch (e) { say("เริ่มเกมไม่สำเร็จ: " + (e.message || e)); }
  finally { setBusy(false); }
}
async function renderQuestion(index) {
  if (!room || room.status !== "playing") return;
  $("roundLabel").textContent = `ROUND ${index + 1}`;
  $("questionText").textContent = "กำลังโหลดคำถาม…";
  $("answers").innerHTML = "";
  $("gameMessage").textContent = "เลือกคำตอบให้เร็วและแม่นยำ!";
  try {
    const q = await rpc("ueu_get_question", { p_room_id: room.id, p_token: token, p_question_index: index });
    $("roundLabel").textContent = `ROUND ${index + 1} / ${q.total_questions}`;
    $("questionText").textContent = q.question;
    $("answers").innerHTML = q.answers.map((a,i) => `<button class="answer" data-answer="${i}">${String.fromCharCode(65+i)}. ${escapeHtml(a)}</button>`).join("");
    const key = `${room.id}-${index}`;
    if (answered.has(key)) $("gameMessage").textContent = "คุณตอบข้อนี้แล้ว รอข้อถัดไป";
    $("answers").querySelectorAll("button").forEach(btn => {
      btn.disabled = answered.has(key);
      btn.addEventListener("click", () => answerQuestion(Number(btn.dataset.answer), btn));
    });
  } catch (e) { $("gameMessage").textContent = "โหลดคำถามไม่สำเร็จ: " + (e.message || e); }
}
async function answerQuestion(choice, btn) {
  const key = `${room.id}-${currentQuestion}`;
  if (answered.has(key) || busy) return;
  answered.add(key);
  $("answers").querySelectorAll("button").forEach(b => b.disabled = true);
  try {
    const result = await rpc("ueu_submit_answer", { p_room_id: room.id, p_token: token, p_question_index: currentQuestion, p_choice: choice });
    btn.classList.add(result.correct ? "correct" : "wrong");
    $("gameMessage").textContent = (result.correct ? `ถูกต้อง! +${result.xp_earned} XP · ` : "ยังไม่ถูก · ") + result.explanation;
    await refreshPlayers();
    if (isHost) {
      setTimeout(async () => {
        try { await rpc("ueu_advance_game", { p_room_id: room.id, p_token: token }); }
        catch (e) { say("เลื่อนไปรอบถัดไปไม่สำเร็จ: " + (e.message || e)); }
      }, 1800);
    }
  } catch (e) {
    answered.delete(key);
    $("gameMessage").textContent = "ส่งคำตอบไม่สำเร็จ: " + (e.message || e);
    $("answers").querySelectorAll("button").forEach(b => b.disabled = false);
  }
}
$("showJoinBtn").addEventListener("click", () => $("joinArea").classList.toggle("hidden"));
$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", joinRoom);
$("startBtn").addEventListener("click", startGame);
$("copyBtn").addEventListener("click", async () => {
  if (!room) return;
  try { await navigator.clipboard.writeText(room.room_code); $("roomStatus").textContent = "คัดลอกรหัสห้องแล้ว ส่งให้เพื่อนได้เลย"; }
  catch { $("roomStatus").textContent = "รหัสห้อง: " + room.room_code + " (คัดลอกด้วยตนเอง)"; }
});
if (!configured) say("กรุณาตั้งค่า Supabase URL และ Publishable key ก่อนเริ่มใช้งาน");
