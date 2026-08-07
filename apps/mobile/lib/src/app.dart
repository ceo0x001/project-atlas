import 'package:flutter/material.dart';

/// The Atlas client shell.
///
/// The layout encodes the core interaction decision (ARCHITECTURE §8): Atlas is
/// voice-*forward*, not voice-only. The canvas occupies the screen and carries the
/// evidence — charts, lists, balances rendered straight from query results — while
/// speech carries the one-sentence answer. A CFO answers out loud and slides the
/// spreadsheet across the table; ears are bad at tables.
///
/// This is the M0 shell. The conversation surface lands in M1 (text) and M3 (voice).
class AtlasApp extends StatelessWidget {
  const AtlasApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Atlas',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0B7A5B)),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF0B7A5B),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            // Canvas: where evidence is rendered from raw query results, never
            // through the language model.
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      Text('Atlas', style: theme.textTheme.displaySmall),
                      const SizedBox(height: 12),
                      Text(
                        'Your money, on the record.',
                        style: theme.textTheme.bodyLarge,
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // Conversation surface.
            Padding(
              padding: const EdgeInsets.all(24),
              child: FilledButton.icon(
                onPressed: null,
                icon: const Icon(Icons.mic_none),
                label: const Text('Talk to Atlas'),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
