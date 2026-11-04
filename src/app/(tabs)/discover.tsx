import { Redirect } from 'expo-router';
import React from 'react';

/**
 * Discover Screen Redirect.
 * In DareDrop, challenges are private and invite-only.
 * Any direct navigation to /discover is safely redirected to Home.
 */
export default function DiscoverScreen() {
  return <Redirect href="/" />;
}
