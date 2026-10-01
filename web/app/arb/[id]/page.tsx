'use client';
import { useParams } from 'next/navigation';
import { ArbDetail } from '@/components/ArbDetail';

export default function ArbPage() {
  const { id } = useParams<{ id: string }>();
  return <ArbDetail id={id} />;
}
