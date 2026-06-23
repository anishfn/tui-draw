/** Per-socket session data stored alongside each Bun WebSocket. */
export interface Session {
  id: string;
  name: string;
  avatar: string;
  joined: boolean;
  roomId: string | null;
}
