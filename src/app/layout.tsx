import type { Metadata } from "next";
import "./globals.css";
import "./theme.css";
import { AudioPlayerProvider } from "@/components/audio-player";
export const metadata: Metadata = {
  title: "AI Inbox",
  description: "Private briefings, release alerts and finished agent results.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><AudioPlayerProvider>{children}</AudioPlayerProvider></body>
    </html>
  );
}
