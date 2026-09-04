/**
 * A sender who types `</untrusted_context>` into a message would otherwise
 * close the fence from inside it and have the rest of the tail read as
 * unfenced context. Entity-escape either fence tag, either way round; the
 * model still sees the words, they just cannot terminate a block.
 *
 * `whatsapp_context` is in here for the same reason and a sharper one. That
 * block is a channel's own, the one carrying `response_instructions`, and
 * its `sender_name` line is a WhatsApp profile name the sender chose: a name
 * of `</whatsapp_context>` closed the trusted block from inside it and left
 * everything the sender wrote after it sitting outside every fence, which is
 * strictly worse than the hole this function was written to close.
 *
 * It lives in its own module rather than in `whatsapp.ts` because every
 * channel that fences a stranger's text needs it, and importing it from the
 * WhatsApp channel bundled that whole channel into Bots that have no
 * WhatsApp: dead code in the image, and one import away from a route nobody
 * meant to serve.
 */
export const neutraliseFence = (block: string): string =>
  block.replaceAll(
    /<(?<slash>\/?)(?<tag>untrusted_context|whatsapp_context)>/giu,
    // The tag is lower-cased on the way out, which is what a literal
    // replacement did when there was only one tag name to write. It keeps
    // the escaped form one shape whatever case the sender typed; the match
    // is case-insensitive either way, so nothing about the escape rests on it.
    (_match, slash: string, tag: string) => `&lt;${slash}${tag.toLowerCase()}&gt;`,
  );
