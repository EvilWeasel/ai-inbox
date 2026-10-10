import { Suspense } from "react";
import { Inbox } from "@/components/inbox";
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="boot-state" aria-busy="true">
          Loading inbox…
        </main>
      }
    >
      <Inbox />
    </Suspense>
  );
}
