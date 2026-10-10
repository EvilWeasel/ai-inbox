import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AI Inbox",
  description: "Your briefings and release alerts.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
