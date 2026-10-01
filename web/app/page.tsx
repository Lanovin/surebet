import { ArbTable } from '@/components/ArbTable';
import { HealthPanel } from '@/components/HealthPanel';

// Klik na arb otevře detail s kalkulačkou v nové záložce (/arb/[id]) – přehled zůstane na hlavním monitoru.
export default function Home() {
  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_340px]">
      <ArbTable />
      <HealthPanel compact />
    </div>
  );
}
