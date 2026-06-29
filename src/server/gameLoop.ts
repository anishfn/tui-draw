/**
 * src/server/gameLoop.ts
 * --------------------------------------------------------------------------
 * Authoritative timer, score, and word-evaluation state machine.
 *
 * The game loop owns the *truth*: whose turn it is, what the secret word is,
 * how much time is left, and who has scored. It knows nothing about sockets or
 * the terminal — it simply mutates internal state on a 1-second tick and hands
 * the broker a fresh snapshot to broadcast through an injected callback.
 *
 * Keeping the loop transport-agnostic (Phase: "explicit separation of core
 * runtime loops from UI component structures") makes it trivially testable and
 * impossible to corrupt from a malformed packet.
 * --------------------------------------------------------------------------
 */

import type {
  Color,
  DrawPointPayload,
  GamePhase,
  GameSnapshot,
  Player,
  SystemAlertPayload,
} from "../types/index.ts";

const AVATARS: readonly string[] = [
  ":3", "^^", ":>", "=D", ";)", "x3", "uwu", "owo",
  "o_o", "._.", ":O", "8)", ":P", ">:)", "-_-", "@_@",
  "T_T", "=3", "c:", "d:",
];

const PLAYER_COLORS: readonly Color[] = [
  "#89b4fa", "#a6e3a1", "#fab387", "#f38ba8",
  "#cba6f7", "#89dceb", "#f9e2af", "#94e2d5",
] as Color[];

/** A modest word bank — easily extended. */
const WORDS: readonly string[] = [
  "answer", "rocket", "guitar", "penguin", "volcano", "diamond", "castle",
  "rainbow", "octopus", "anchor", "bicycle", "dragon", "pirate", "compass",
  "lantern", "cactus", "tornado", "pyramid", "harbor", "wizard",
];

/** How long each drawing turn lasts, in seconds. */
const TURN_SECONDS = 80;
/** How long the drawer has to pick one of the three offered words. */
const SELECT_SECONDS = 15;
/** Pause between turns so players can read the scoreboard. */
const INTERMISSION_SECONDS = 5;
/** How long the final match leaderboard stays up before returning to lobby. */
const GAMEOVER_SECONDS = 12;
/** Points awarded to the drawer each time someone guesses correctly. */
const DRAWER_REWARD = 25;
/** How many words the drawer chooses between at the start of a turn. */
const WORD_CHOICE_COUNT = 3;
/** Minimum players required before the host may start the game. */
export const MIN_PLAYERS_TO_START = 2;
/** Clamp a requested round count to the supported 1..10 range. */
function clampRounds(rounds: number): number {
  if (!Number.isFinite(rounds)) return 3;
  return Math.max(1, Math.min(10, Math.round(rounds)));
}

/**
 * The internal player record. Mirrors the public {@link Player} but also tracks
 * the live socket-side handle id and per-turn bookkeeping.
 */
export interface ServerPlayer extends Player {}

/** Side-effecting hooks the broker wires into the loop. */
export interface GameLoopHooks {
  /** Push the latest authoritative snapshot to everyone (drawer gets the word). */
  broadcastSnapshot: () => void;
  /** Emit a system alert to the whole lobby. */
  broadcastAlert: (alert: SystemAlertPayload) => void;
  /** Order every client to wipe its canvas. */
  broadcastClear: () => void;
  /** Privately offer the drawer their three word choices. */
  sendChoices: (drawerId: string, words: string[]) => void;
}

export class GameLoop {
  private players = new Map<string, ServerPlayer>();
  /** Ordered ids defining drawer rotation. */
  private rotation: string[] = [];
  private phase: GamePhase = "lobby";
  private drawerId: string | null = null;
  /** The host (room creator / first joiner) — only they can start the game. */
  private hostId: string | null = null;
  private word: string | null = null;
  /** The three words currently offered to the drawer during `selecting`. */
  private choices: string[] = [];
  private timeLeft = 0;
  private round = 0;
  /** How many full rounds (everyone draws once) the game runs. Host-set. */
  private totalRounds = 3;
  /** Replay buffer for the current turn's strokes. */
  private history: DrawPointPayload[] = [];
  /** Index into {@link rotation} for the next drawer. */
  private rotationCursor = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private usedAvatars = new Set<string>();
  private colorCursor = 0;
  /** Shuffled letter indices, revealed one-by-one as the turn timer drains. */
  private revealOrder: number[] = [];
  /** True while the final results leaderboard is on screen (intermission phase). */
  private gameOver = false;

  constructor(private readonly hooks: GameLoopHooks, initialRounds = 3) {
    this.totalRounds = clampRounds(initialRounds);
  }

  /* ----------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ----------------------------------------------------------------------- */

  /** Begin the 1Hz authoritative tick. Idempotent. */
  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  /** Stop the tick and release the timer (used on shutdown / tests). */
  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Membership                                                              */
  /* ----------------------------------------------------------------------- */

  addPlayer(id: string, name: string): ServerPlayer {
    const player: ServerPlayer = {
      id,
      name,
      score: 0,
      isDrawing: false,
      hasGuessed: false,
      avatar: this.pickAvatar(),
      color: this.pickColor(),
    };
    this.players.set(id, player);
    this.rotation.push(id);

    // The first player to arrive becomes the host who starts the game.
    if (this.hostId === null) this.hostId = id;

    // The game never auto-starts: the host kicks it off explicitly. New joiners
    // simply appear in the roster (and spectate until the next turn mid-game).
    this.hooks.broadcastSnapshot();
    return player;
  }

  removePlayer(id: string): void {
    const wasDrawer = this.drawerId === id;
    const leaving = this.players.get(id);
    if (leaving) this.usedAvatars.delete(leaving.avatar);
    this.players.delete(id);
    this.rotation = this.rotation.filter((p) => p !== id);
    if (this.rotationCursor > this.rotation.length) this.rotationCursor = 0;

    // Hand the host crown to the next remaining player if the host left.
    if (this.hostId === id) this.hostId = this.rotation[0] ?? null;

    if (this.players.size === 0) {
      this.gotoLobby();
      return;
    }
    // Not enough players to keep playing — fall back to the lobby and wait for
    // the host to start again once someone else joins.
    if (this.players.size < MIN_PLAYERS_TO_START && this.phase !== "lobby") {
      this.hooks.broadcastAlert({
        kind: "round",
        text: "Not enough players - back to the lobby.",
      });
      this.gotoLobby();
      return;
    }
    // If the drawer dropped, the turn cannot continue — move on immediately.
    if (wasDrawer && (this.phase === "drawing" || this.phase === "selecting")) {
      this.hooks.broadcastAlert({
        kind: "info",
        text: "The drawer left - starting a new turn.",
      });
      this.beginIntermission();
    } else {
      this.hooks.broadcastSnapshot();
    }
  }

  /** Whether the given player currently holds the pen. */
  isDrawer(id: string): boolean {
    return this.drawerId === id;
  }

  /* ----------------------------------------------------------------------- */
  /* Host / start-game controls                                              */
  /* ----------------------------------------------------------------------- */

  /**
   * Start the game on the host's request. No-op unless the requester is the
   * host, we're idling in the lobby, and there are enough players.
   */
  startGame(playerId: string): void {
    if (playerId !== this.hostId) return;
    if (this.phase !== "lobby") return;
    if (this.players.size < MIN_PLAYERS_TO_START) {
      this.hooks.broadcastAlert({
        kind: "info",
        text: `Need at least ${MIN_PLAYERS_TO_START} players to start.`,
      });
      return;
    }
    // Fresh game: wipe last game's scores.
    for (const p of this.players.values()) p.score = 0;
    this.round = 0;
    this.rotationCursor = 0;
    this.gameOver = false;
    this.beginSelection();
  }

  /**
   * Set how many rounds the game runs. Only the host may change it, and only
   * from the lobby. Clamped to a sane range.
   */
  setRounds(playerId: string, rounds: number): void {
    if (playerId !== this.hostId || this.phase !== "lobby") return;
    if (!Number.isFinite(rounds)) return;
    this.totalRounds = Math.max(1, Math.min(10, Math.round(rounds)));
    this.hooks.broadcastSnapshot();
  }

  /** The drawer commits to one of the three offered words. */
  chooseWord(playerId: string, index: number): void {
    if (this.phase !== "selecting" || playerId !== this.drawerId) return;
    const picked = this.choices[index];
    if (!picked) return;
    this.beginDrawing(picked);
  }

  /** Current game phase (for room info snapshots). */
  getPhase(): GamePhase {
    return this.phase;
  }

  /* ----------------------------------------------------------------------- */
  /* Drawing history                                                         */
  /* ----------------------------------------------------------------------- */

  /** Record a stroke sample for replay to late joiners. */
  recordPoint(point: DrawPointPayload): void {
    // Cap the buffer so a long turn can't grow unbounded.
    if (this.history.length < 20000) this.history.push(point);
  }

  clearHistory(): void {
    this.history = [];
  }

  /* ----------------------------------------------------------------------- */
  /* Guess evaluation                                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Evaluate a chat message as a potential guess.
   *
   * @returns `"correct"` if it matched the word (caller should suppress the raw
   *          chat so the answer isn't leaked), `"close"` if it's one edit away,
   *          or `"miss"` for an ordinary chat line that should be relayed.
   */
  evaluateGuess(playerId: string, content: string): "correct" | "close" | "miss" {
    const player = this.players.get(playerId);
    if (
      !player ||
      this.phase !== "drawing" ||
      this.word === null ||
      player.isDrawing ||
      player.hasGuessed
    ) {
      return "miss";
    }

    const guess = content.trim().toLowerCase();
    if (guess.length === 0) return "miss";

    if (guess === this.word) {
      // Score scales with how much time is left — faster guesses score more.
      const reward = Math.max(10, Math.round((this.timeLeft / TURN_SECONDS) * 100));
      player.score += reward;
      player.hasGuessed = true;

      const drawer = this.drawerId ? this.players.get(this.drawerId) : undefined;
      if (drawer) drawer.score += DRAWER_REWARD;

      this.hooks.broadcastAlert({
        kind: "correct",
        text: `${player.name} guessed the word! (+${reward})`,
      });
      this.hooks.broadcastSnapshot();

      // If everyone (besides the drawer) has guessed, end the turn early.
      if (this.allGuessed()) {
        this.hooks.broadcastAlert({ kind: "round", text: "Everyone guessed it!" });
        this.beginIntermission();
      }
      return "correct";
    }

    if (this.isOneEditAway(guess, this.word)) return "close";
    return "miss";
  }

  /* ----------------------------------------------------------------------- */
  /* Snapshot                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Build a snapshot. When `forId` is the current drawer, the real word is
   * included; everyone else receives only the masked hint.
   */
  snapshotFor(forId: string | null): GameSnapshot {
    return {
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({ ...p })),
      drawerId: this.drawerId,
      selfId: forId ?? "",
      hostId: this.hostId,
      hint: this.maskedHint(),
      word: this.phase === "drawing" && forId !== null && forId === this.drawerId ? this.word : null,
      reveal: this.phase === "intermission" && !this.gameOver ? this.word : null,
      timeLeft: this.timeLeft,
      round: this.round,
      totalRounds: this.totalRounds,
      gameOver: this.gameOver,
      history: this.history,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Internal: turn machine                                                  */
  /* ----------------------------------------------------------------------- */

  private tick(): void {
    if (this.phase === "selecting") {
      this.timeLeft -= 1;
      if (this.timeLeft <= 0) {
        // Out of time picking — auto-select the first offered word.
        this.beginDrawing(this.choices[0] ?? "answer");
        return;
      }
      this.hooks.broadcastSnapshot();
    } else if (this.phase === "drawing") {
      this.timeLeft -= 1;
      if (this.timeLeft <= 0) {
        this.hooks.broadcastAlert({
          kind: "round",
          text: `Time's up! The word was "${this.word}".`,
        });
        this.beginIntermission();
        return;
      }
      // Periodic countdown + progressively reveal a letter near the end.
      if (this.timeLeft <= 10 || this.timeLeft % 15 === 0) {
        this.hooks.broadcastAlert({ kind: "tick", text: `${this.timeLeft}s left` });
      }
      this.hooks.broadcastSnapshot();
    } else if (this.phase === "intermission") {
      this.timeLeft -= 1;
      if (this.timeLeft <= 0) {
        // The final leaderboard returns everyone to the lobby; a normal
        // intermission advances to the next drawer's word selection.
        if (this.gameOver) {
          this.gameOver = false;
          this.gotoLobby();
        } else {
          this.beginSelection();
        }
      } else {
        this.hooks.broadcastSnapshot();
      }
    }
  }

  /**
   * Advance to the next drawer and offer them three words to pick from. The
   * choices are sent privately to the drawer; everyone else just sees that the
   * drawer is choosing.
   */
  private beginSelection(): void {
    if (this.players.size < MIN_PLAYERS_TO_START) {
      this.gotoLobby();
      return;
    }

    // Reset per-turn flags.
    for (const p of this.players.values()) {
      p.hasGuessed = false;
      p.isDrawing = false;
    }

    // Pick the next drawer from the rotation.
    if (this.rotationCursor >= this.rotation.length) {
      this.rotationCursor = 0;
      this.round += 1;
    }
    if (this.round === 0) this.round = 1;

    // The game is over once we'd start a round beyond the configured total.
    if (this.round > this.totalRounds) {
      this.endGame();
      return;
    }

    const drawerId = this.rotation[this.rotationCursor] ?? this.rotation[0]!;
    this.rotationCursor += 1;
    this.drawerId = drawerId;

    const drawer = this.players.get(drawerId);
    if (drawer) drawer.isDrawing = true;

    this.word = null;
    this.choices = this.pickWords(WORD_CHOICE_COUNT);
    this.phase = "selecting";
    this.timeLeft = SELECT_SECONDS;
    this.clearHistory();
    this.hooks.broadcastClear();

    this.hooks.broadcastAlert({
      kind: "role",
      text: `${drawer?.name ?? "Someone"} is choosing a word...`,
    });
    this.hooks.sendChoices(drawerId, this.choices);
    this.hooks.broadcastSnapshot();
  }

  /** Lock in the chosen word and open the drawing turn. */
  private beginDrawing(word: string): void {
    this.word = word;
    this.choices = [];
    this.revealOrder = this.shuffledLetterIndices(word);
    this.phase = "drawing";
    this.timeLeft = TURN_SECONDS;
    this.clearHistory();
    this.hooks.broadcastClear();

    const drawer = this.drawerId ? this.players.get(this.drawerId) : undefined;
    this.hooks.broadcastAlert({
      kind: "role",
      text: `${drawer?.name ?? "Someone"} is drawing - start guessing!`,
    });
    this.hooks.broadcastSnapshot();
  }

  private beginIntermission(): void {
    this.phase = "intermission";
    this.timeLeft = INTERMISSION_SECONDS;
    this.choices = [];
    if (this.drawerId) {
      const drawer = this.players.get(this.drawerId);
      if (drawer) drawer.isDrawing = false;
    }
    this.hooks.broadcastSnapshot();
  }

  /**
   * Announce the winner and show the final leaderboard. We linger on a
   * game-over intermission (rather than dropping straight to the lobby) so
   * everyone can see the full ranking before the next tick returns them.
   */
  private endGame(): void {
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    const winner = ranked[0];
    this.hooks.broadcastAlert({
      kind: "correct",
      text: winner
        ? `Game over! ${winner.name} wins with ${winner.score} points!`
        : "Game over!",
    });
    this.gameOver = true;
    this.phase = "intermission";
    this.drawerId = null;
    this.word = null;
    this.choices = [];
    this.timeLeft = GAMEOVER_SECONDS;
    this.clearHistory();
    this.hooks.broadcastClear();
    this.hooks.broadcastSnapshot();
  }

  private gotoLobby(): void {
    this.phase = "lobby";
    this.gameOver = false;
    this.drawerId = null;
    this.word = null;
    this.choices = [];
    this.timeLeft = 0;
    this.clearHistory();
    this.hooks.broadcastSnapshot();
  }

  /** True once every non-drawer has guessed correctly. */
  private allGuessed(): boolean {
    const guessers = [...this.players.values()].filter((p) => !p.isDrawing);
    return guessers.length > 0 && guessers.every((p) => p.hasGuessed);
  }

  private pickAvatar(): string {
    for (const a of AVATARS) {
      if (!this.usedAvatars.has(a)) {
        this.usedAvatars.add(a);
        return a;
      }
    }
    return AVATARS[Math.floor(Math.random() * AVATARS.length)] ?? ":)";
  }

  /** Pick `n` distinct random words from the bank for the drawer to choose. */
  private pickWords(n: number): string[] {
    const pool = [...WORDS];
    const out: string[] = [];
    for (let i = 0; i < n && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      out.push(pool.splice(idx, 1)[0]!);
    }
    return out;
  }

  private pickColor(): Color {
    const idx = this.colorCursor % PLAYER_COLORS.length;
    this.colorCursor++;
    return PLAYER_COLORS[idx] ?? ("#ffffff" as Color);
  }

  /**
   * Produce the spaced, masked hint shown to guessers, e.g. "_ A _ _ E R".
   * Letters are progressively revealed (up to half the word) as the turn timer
   * drains, so a stalled round still nudges guessers toward the answer.
   */
  private maskedHint(): string {
    if (!this.word || this.phase !== "drawing") return "";
    const shown = new Set(this.revealOrder.slice(0, this.revealCount()));
    return this.word
      .split("")
      .map((ch, i) => (ch === " " ? " " : shown.has(i) ? ch.toUpperCase() : "_"))
      .join(" ");
  }

  /** How many letters are currently revealed, scaling with elapsed turn time. */
  private revealCount(): number {
    const max = this.revealOrder.length; // already capped at half the letters
    if (max === 0) return 0;
    const elapsed = 1 - this.timeLeft / TURN_SECONDS;
    return Math.max(0, Math.min(max, Math.floor(elapsed * (max + 1))));
  }

  /** A shuffled list of letter (non-space) indices, capped at half the word. */
  private shuffledLetterIndices(word: string): number[] {
    const idx = word
      .split("")
      .map((ch, i) => (ch === " " ? -1 : i))
      .filter((i) => i >= 0);
    // Fisher-Yates shuffle.
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return idx.slice(0, Math.floor(idx.length / 2));
  }

  /** Cheap Levenshtein-≤1 check used to nudge "so close" guesses. */
  private isOneEditAway(a: string, b: string): boolean {
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;

    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (++edits > 1) return false;
      if (la > lb) i++;
      else if (lb > la) j++;
      else {
        i++;
        j++;
      }
    }
    if (i < la || j < lb) edits++;
    return edits <= 1;
  }
}
