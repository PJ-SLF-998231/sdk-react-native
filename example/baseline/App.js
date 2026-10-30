// The same screen as ../App.js with a plain button and no Shelf SDK, as the size baseline.
import React from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';

export default function App() {
  const [last, setLast] = React.useState('Nothing uploaded yet.');
  return (
    <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <View style={{ gap: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: '600' }}>Baseline (no SDK)</Text>
        <Pressable onPress={() => setLast('pressed')}>
          <Text>Take photo</Text>
        </Pressable>
        <Text>{last}</Text>
      </View>
    </SafeAreaView>
  );
}
