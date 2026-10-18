"""Host-side interpretation. Raw timestamped events remain available for future estimators."""
from collections import deque

class AngleDecoder:
    POSITIVE = {(3, 1), (1, 0), (0, 2), (2, 3)}

    def __init__(self):
        self.transitions = 4
        self.sign = 1
        self.steps_per_turn = 20.0
        self.reset()

    def reset(self):
        self.positive = self.negative = self.invalid = self.gaps = self.valid_edges = 0
        self.partial = 0
        self.state = self.seq = self.lost = None
        self.synced = False
        self.available = False
        self.rest = None
        self.recent = deque(maxlen=10)
        self.previous_us = None
        self.boot_id = None

    @property
    def steps(self):
        return self.sign * (self.positive-self.negative)

    def anchor(self, value):
        return value in (0,3) if self.transitions == 2 else value == self.rest

    def sync(self, value):
        if self.rest is None and value in (0,3):
            self.rest = value
        self.state = value
        self.partial = 0
        self.synced = self.anchor(value)

    def feed(self, value):
        if value == self.state:
            return
        previous = self.state
        self.state = value
        if previous is None:
            self.sync(value)
            return
        if previous ^ value == 3:
            self.invalid += 1
            self.sync(value)
            return
        self.valid_edges += 1
        if not self.synced:
            if self.anchor(value) or (self.rest is None and value in (0,3)): self.sync(value)
            return
        self.partial += 1 if (previous, value) in self.POSITIVE else -1
        if self.anchor(value):
            if abs(self.partial) == self.transitions:
                if self.partial > 0: self.positive += 1
                else: self.negative += 1
            # A return to a detent without a full valid path contributes no step.
            self.partial = 0

    def packet(self, data):
        boot = data.get('boot_id')
        if self.boot_id is not None and boot is not None and boot != self.boot_id:
            self.reset()
        self.boot_id = boot
        start, seq, lost = data['start'], data['seq'], data['lost']
        timestamped = data.get('fw') == 'S3_GPIO45_RAW_TIME_V4'
        events = [x[1] for x in data['events']] if timestamped else data['events']
        previous = start
        for i, value in enumerate(events):
            timestamp = data['events'][i][0] if timestamped else None
            dt = None if timestamp is None or self.previous_us is None else timestamp-self.previous_us
            diff = previous ^ value
            direction = 0 if diff in (0,3) else (1 if (previous,value) in self.POSITIVE else -1)
            self.recent.append(dict(t_us=timestamp,dt_us=dt,previous=previous,state=value,
                                    direction=direction,valid=diff in (1,2)))
            self.previous_us = timestamp
            previous = value
        discontinuity = (self.seq is not None and
                         (seq != ((self.seq + 1) & 0xffffffff) or lost != self.lost or start != self.state))
        if discontinuity:
            self.gaps += 1
            self.sync(start)
            # Never count a batch across missing/corrupt history.
            for value in events: self.sync(value)
        else:
            if self.state is None: self.sync(start)
            for value in events: self.feed(value)
        self.seq, self.lost, self.available = seq, lost, True

    def snapshot(self):
        degrees = self.steps*360/self.steps_per_turn
        return dict(available=self.available, steps=self.steps, angle=degrees % 360,
                    total_angle=degrees, turns=self.steps/self.steps_per_turn,
                    positive_count=self.positive if self.sign==1 else self.negative,
                    negative_count=self.negative if self.sign==1 else self.positive,
                    steps_per_turn=self.steps_per_turn, degrees_per_step=360/self.steps_per_turn,
                    recent_inputs=list(self.recent), estimator='strict_quadrature_no_prediction',
                    invalid=self.invalid, gaps=self.gaps, valid_edges=self.valid_edges,
                    partial=self.partial, transitions=self.transitions, sign=self.sign,
                    synced=self.synced)
