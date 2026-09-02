import { siteConfig } from "@/lib/config";

export function InviteNotice({
  message,
  title,
}: {
  message: string;
  title: string;
}): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center bg-ink p-6">
      <div className="w-full max-w-sm space-y-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-mute">{message}</p>
        <p className="text-xs text-mute">{siteConfig.name}</p>
      </div>
    </div>
  );
}
