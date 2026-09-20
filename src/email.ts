import { env } from './env.js';

export interface Attachment {
  filename: string;
  /** UTF-8 content; base64-encoded on the way out. */
  content: string;
  contentType: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export interface Transport {
  readonly name: string;
  send(email: OutboundEmail): Promise<void>;
}

/** Everything the console transport "sent", so tests and the demo can inspect it. */
export const sentMail: OutboundEmail[] = [];

const consoleTransport: Transport = {
  name: 'console',
  async send(email) {
    sentMail.push(email);
    if (sentMail.length > 50) sentMail.shift();
    console.log(
      `\n--- email (no RESEND_API_KEY, not actually sent) ---\n` +
        `To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n` +
        (email.attachments?.length
          ? `Attachments: ${email.attachments.map((a) => a.filename).join(', ')}\n`
          : '') +
        `---------------------------------------------------\n`,
    );
  },
};

const resendTransport: Transport = {
  name: 'resend',
  async send(email) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.mailFrom,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: email.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: Buffer.from(attachment.content, 'utf8').toString('base64'),
          content_type: attachment.contentType,
        })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend rejected the message (${response.status}): ${await response.text()}`);
    }
  },
};

/**
 * Without an API key the app still works end to end — confirmations are logged
 * instead of sent. A demo that falls over because nobody configured SMTP is a
 * demo nobody sees.
 */
export function createTransport(): Transport {
  return env.resendApiKey ? resendTransport : consoleTransport;
}

/** Never let a failed confirmation email lose a booking that is already stored. */
export async function sendQuietly(transport: Transport, email: OutboundEmail): Promise<void> {
  try {
    await transport.send(email);
  } catch (error) {
    console.error(`Failed to send "${email.subject}" to ${email.to}:`, error);
  }
}
