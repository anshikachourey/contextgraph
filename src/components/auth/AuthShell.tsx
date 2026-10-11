import { Center } from "@astryxdesign/core/Center";
import { Card } from "@astryxdesign/core/Card";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * Shared frame for every Auth_Screen (Task 8.4).
 *
 * Feature: google-oauth-authentication
 *
 * A capped, centered content column is the right frame for forms (see
 * `astryx docs layout` → "prose, forms, and lists cap"). We use Center to place
 * a single Card on the viewport, with a VStack owning all interior spacing. No
 * raw <div>, no hex, no px — layout and spacing come from components + tokens.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Center axis="both" minHeight="100vh" padding={4}>
      <Card width={400} maxWidth="100%" padding={6} elevation="low">
        <VStack gap={5}>
          <VStack gap={1}>
            <Heading level={1}>{title}</Heading>
            {subtitle ? <Text color="secondary">{subtitle}</Text> : null}
          </VStack>

          {children}

          {footer ? <VStack gap={2}>{footer}</VStack> : null}
        </VStack>
      </Card>
    </Center>
  );
}
