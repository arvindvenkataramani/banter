import Foundation

/// Fires when nothing has happened for a while.
///
/// Long-running work owns the one resident model, so a client that stops
/// sending without closing holds it indefinitely and the server refuses all
/// other work. TCP will not notice for minutes; this does.
///
/// `poke()` restarts the clock and is cheap enough to call on every frame.
/// `expire()` returns once the interval passes without one.
public actor IdleWatchdog {
    private let interval: Duration
    private var lastPoke: ContinuousClock.Instant = .now

    public init(seconds: Int) {
        self.interval = .seconds(seconds)
    }

    public init(interval: Duration) {
        self.interval = interval
    }

    public func poke() {
        lastPoke = .now
    }

    /// Returns when the interval elapses with no poke. Sleeps in slices rather
    /// than scheduling against a deadline, so a poke does not have to cancel
    /// and rebuild a timer on every frame.
    ///
    /// Stopping the watchdog is cancelling the task that awaits this; there is
    /// no separate cancel, so there is no way for the two to disagree.
    public func expire() async {
        while true {
            try? await Task.sleep(for: interval / 4)
            if Task.isCancelled { return }
            if ContinuousClock.now - lastPoke >= interval { return }
        }
    }
}
