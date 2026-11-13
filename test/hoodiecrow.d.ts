declare module 'hoodiecrow-imap' {
  interface Mailbox {
    messages: { uid: number; flags: string[]; raw: string }[]
  }
  interface Server {
    listen(port: number, host: string, cb: () => void): void
    address(): { port: number }
    close(cb?: () => void): void
    getMailbox(path: string): Mailbox
    appendMessage(mailbox: Mailbox, flags: string[], internaldate: Date, raw: string): void
  }
  export default function hoodiecrow(options: Record<string, unknown>): Server
}
