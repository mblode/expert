import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound(): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-3 text-center">
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="text-sm text-mute">That page does not exist.</p>
        <Button render={<Link href="/" />} variant="link">
          Back to the computer
        </Button>
      </div>
    </div>
  );
}
