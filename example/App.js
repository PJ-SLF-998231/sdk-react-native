// The only SDK import is the camera entry. No folder, document, list or picker code is bundled.
import React from 'react';
import { SafeAreaView, Text, View } from 'react-native';
import { CameraButton } from '@pj-slf-998231/sdk-react-native/camera';

// Point this at your own proxy (see the SDK README, "Security model"). The default is the local mock server
// started by `npm run mock`; on an Android emulator use http://10.0.2.2:8787/api/shelf, on a device your LAN IP.
const BASE_URL = process.env.EXPO_PUBLIC_SHELF_BASE_URL ?? 'http://localhost:8787/api/shelf';

// The app's own session token for YOUR backend. It is not a Shelf key; the proxy holds that.
const getHeaders = () => ({ Authorization: 'Bearer demo-session' });

export default function App() {
  const [last, setLast] = React.useState('Nothing uploaded yet.');
  return (
    <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <View style={{ gap: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>Shelf camera example</Text>
        <CameraButton
          baseUrl={BASE_URL}
          getHeaders={getHeaders}
          uploadMode="direct"
          onUploaded={(doc) => setLast(`Uploaded: ${doc?.filename ?? doc?.id}`)}
          onError={(e) => setLast(`Error: ${e.message}`)}
        />
        <Text>{last}</Text>
      </View>
    </SafeAreaView>
  );
}
