/** The signed-in user. The sign-in change fills it; null until then. */
export type Session = {
  user: { name: string; email: string; avatar?: string };
} | null;
