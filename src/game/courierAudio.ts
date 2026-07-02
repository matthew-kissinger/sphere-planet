type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export class CourierAudio {
  enabled = true;
  private context: AudioContext | null = null;
  private unlocked = false;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async unlock(): Promise<void> {
    if (!this.enabled || this.unlocked) return;
    const AudioCtor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!AudioCtor) return;
    if (!this.context) this.context = new AudioCtor();
    if (this.context.state !== 'running') await this.context.resume();
    this.unlocked = true;
  }

  ui(): void {
    this.tone(520, 0.045, 0.035, 'triangle');
  }

  start(): void {
    this.sequence([392, 523, 659], 0.07, 0.045);
  }

  ring(chain: number): void {
    const lift = Math.min(7, Math.max(0, chain - 1)) * 24;
    this.sequence([760 + lift, 1040 + lift], 0.055, 0.05);
  }

  success(): void {
    this.sequence([440, 554, 659, 880], 0.085, 0.06);
  }

  fail(): void {
    this.sequence([220, 165], 0.13, 0.08, 'sawtooth', 0.08);
  }

  private sequence(
    freqs: number[],
    stepSeconds: number,
    volume: number,
    type: OscillatorType = 'sine',
    startDelay = 0,
  ): void {
    for (let i = 0; i < freqs.length; i++) {
      this.tone(freqs[i], stepSeconds, volume, type, startDelay + i * stepSeconds * 0.78);
    }
  }

  private tone(
    frequency: number,
    durationSeconds: number,
    volume: number,
    type: OscillatorType,
    delaySeconds = 0,
  ): void {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const now = this.context.currentTime + delaySeconds;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSeconds);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now);
    osc.stop(now + durationSeconds + 0.02);
  }
}
