/**
 * Structured data as a plain script tag: this is data, not code, so not
 * `next/script`. `JSON.stringify` does not escape `<`; the unicode escape is
 * what the Next.js JSON-LD guide recommends, applied every time rather than
 * per field, so a later content change cannot turn into script injection.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }): React.ReactElement {
  return (
    <script
      // oxlint-disable-next-line react/no-danger -- JSON-LD is the documented use; `<` is escaped above.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replaceAll("<", "\\u003c") }}
      type="application/ld+json"
    />
  );
}
