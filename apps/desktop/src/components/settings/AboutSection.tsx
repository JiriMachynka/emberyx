import { Button } from "@/components/ui/button";
import { Group, Row } from "@/components/SettingsFields";

export const AboutSection = ({
  version,
  checking,
  onCheckUpdates,
}: {
  version: string;
  checking: boolean;
  onCheckUpdates: () => Promise<void>;
}) => (
  <Group>
    <Row
      label="Updates"
      hint={version ? `Emberyx v${version}` : "Emberyx"}
      control={
        <Button
          variant="outline"
          size="sm"
          onClick={onCheckUpdates}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      }
    />
  </Group>
);
