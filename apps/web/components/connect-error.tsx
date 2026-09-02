"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/lib/config";

export function ConnectError({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div>
          <h1 className="text-xl font-semibold">{siteConfig.name}</h1>
          <p className="mt-1 text-sm text-mute">
            Signed in, but the web server could not attach to the box.
          </p>
        </div>
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <Button className="w-full" onClick={onRetry} size="input" type="button">
          Try again
        </Button>
        <Button className="w-full" onClick={onSignOut} size="input" type="button" variant="outline">
          Sign out
        </Button>
      </div>
    </div>
  );
}
