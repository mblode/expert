/** Fragments stay out of HTTP requests and referrer headers. */
export function whatsappLoginLink(phone: string, code: string): string {
  const hash = new URLSearchParams({ phone, code });
  return `https://hello.expert/login#${hash}`;
}

export function readWhatsAppLoginLink(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/u, ""));
  const phone = params.get("phone") ?? "";
  const code = params.get("code") ?? "";
  if (!/^[1-9][0-9]{7,14}$/u.test(phone) || !/^[0-9]{6}$/u.test(code)) return undefined;
  return { phone: `+${phone}`, code };
}
