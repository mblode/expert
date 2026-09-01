"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";

import { LoginForm } from "./login-form";

export function LoginGate({
  appleEnabled,
  googleEnabled,
}: {
  appleEnabled: boolean;
  googleEnabled: boolean;
}): React.ReactElement {
  const router = useRouter();
  const { data: session } = authClient.useSession();

  useEffect(() => {
    if (session) router.replace("/");
  }, [router, session]);

  return <LoginForm appleEnabled={appleEnabled} googleEnabled={googleEnabled} />;
}
