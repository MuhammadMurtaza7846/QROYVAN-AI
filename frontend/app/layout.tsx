import type { Metadata } from 'next';
import './globals.css';
import MotionController from './MotionController';
export const metadata: Metadata = { title: 'QROYVAN AI — Knowledge in Conversation', description: 'Your cinematic AI knowledge assistant' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><MotionController />{children}</body></html>; }

