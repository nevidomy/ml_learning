from .vgrad import Var
import random
import math

class Neuron:
    def __init__(self, input_size, activationFunction='tanh',  label=None):
        self.input_size = input_size
        self.weights = [Var(random.uniform(-1.0, 1.0), label=f"{label}w{i}") for i in range(self.input_size)]
        self.bias = Var(random.uniform(-1.0, 1.0), label=f"{label}b")
        self.activationFunction = activationFunction

    def __call__(self, inputs):
        self.activation = Var.sum(input * weight for input, weight in zip(inputs, self.weights)) + self.bias
        
        if self.activationFunction == 'tanh':
            self.output = self.activation.tanh()
        elif self.activationFunction == 'none':
            self.output = self.activation

        return self.output

    def parameters(self):
        return self.weights + [self.bias]

    def visualize(self):
        self.output.visualize()

class Layer:
    def __init__(self, input_size, num_neurons, activationFunction='tanh', label=None):
        self.neurons = [Neuron(input_size, activationFunction, label=f"{label}N{i}") for i in range(num_neurons)]

    def __call__(self, inputs):
        return [neuron(inputs) for neuron in self.neurons]

    def parameters(self):
        return [p for neuron in self.neurons for p in neuron.parameters()]

class NNetwork:
    def __init__(self, shape, lastLayerActivationFunction='tanh'):
        self.input_size = shape[0]
        self.layers = [Layer(
            shape[i], 
            shape[i+1],  
            activationFunction='tanh' if i < len(shape) - 2 else lastLayerActivationFunction,
            label=f"L{i+1}") for i in range(len(shape) - 1)]

    def __call__(self, inputs, softMaxLosses=None):
        assert len(inputs) == self.input_size, f"Input size must be {self.input_size}"
        
        for layer in self.layers:
            inputs = layer(inputs)

        return inputs if len(inputs) > 1 else inputs[0]

    def parameters(self):
        return [p for layer in self.layers for p in layer.parameters()]


    def zero_grad(self):
        for param in self.parameters():
            param.grad = 0.0 

inputs = [
    [Var(0.1), Var(0.2), Var(0.3)],
    [Var(0.4), Var(0.5), Var(0.6)],
    [Var(0.7), Var(0.8), Var(0.9)],
]
outputs = [
    Var(-0.5, 'y1'),
    Var(0.5, 'y2'),
    Var(0.25, 'y3'),
]



def run_learning(momentum_decay, learning_rate, runs=5, target_loss=1e-20):
    res = 0
    for _ in range(runs):
        N = NNetwork([3,3,1])
        velocity = [0.0 for _ in N.parameters()]
        reached_target = False
        for iteration in range(100000):
            loss = Var.sum([(N(input) - output)**2 for input, output in zip(inputs, outputs)]) * Var(1.0/len(inputs))
            #print(f"Iteration {iteration}: Loss = {loss.value}")
            N.zero_grad()
            loss.backward()
            for i, param in enumerate(N.parameters()):
                velocity[i] = velocity[i] * momentum_decay + param.grad
                param.value -= learning_rate * velocity[i]
            if (abs(loss.value) < target_loss):
                res += iteration
                reached_target = True
                break
        assert reached_target, "Loss not reached"
    return res / runs

def run_learning2(momentum_decay, learning_rate, runs=5, target_loss=1e-20):
    res = 0
    for _ in range(runs):
        N = NNetwork([3,3,1])
        velocity = [0.0 for _ in N.parameters()]
        vsq = [0.0 for _ in N.parameters()]
        reached_target = False
        for iteration in range(10000):
            loss = Var.sum([(N(input) - output)**2 for input, output in zip(inputs, outputs)]) * Var(1.0/len(inputs))
            #print(f"Iteration {iteration}: Loss = {loss.value}")
            N.zero_grad()
            loss.backward()
            for i, param in enumerate(N.parameters()):
                velocity[i] = velocity[i] * momentum_decay + param.grad
                vsq[i] = vsq[i] * 0.999 + 0.001 * param.grad**2
                param.value -= learning_rate * velocity[i] / (vsq[i]**0.5 + 1e-8)
            if (abs(loss.value) < target_loss):
                res += iteration
                reached_target = True
                break
        assert reached_target, "Loss not reached"
    return res / runs

#print(run_learning(0.89, 0.5))
#print(run_learning2(0.75, 0.007))


inputs2 = [
    [Var(0.1), Var(0.2), Var(0.3)],
    [Var(0.4), Var(0.5), Var(0.6)],
    [Var(0.7), Var(0.8), Var(0.9)],
]
outputs2 = [
    [Var(0.0), Var(0.0), Var(1.0)],
    [Var(0.0), Var(1.0), Var(0.0)],
    [Var(1.0), Var(0.0), Var(0.0)],
]
outputs2index = [2,1,0]


def run_learning3(momentum_decay, learning_rate, runs=5, target_loss=1e-10):
    res = 0
    for _ in range(runs):
        N = NNetwork([3,3,3], lastLayerActivationFunction='none')
        velocity = [0.0 for _ in N.parameters()]
        vsq = [0.0 for _ in N.parameters()]
        reached_target = False
        for iteration in range(100000):
            loss = Var.sum(
                [Var.crossEntropyLoss(N(input), output) for input, output in zip(inputs, outputs2index)]) * Var(1.0/len(inputs))
            if (iteration % 100 == 0): 
                print(f"Iteration {iteration}: Loss = {loss.value}")
            N.zero_grad()
            loss.backward()
            for i, param in enumerate(N.parameters()):
                velocity[i] = velocity[i] * momentum_decay + param.grad
                vsq[i] = vsq[i] * 0.999 + 0.001 * param.grad**2
                param.value -= learning_rate * velocity[i] / (vsq[i]**0.5 + 1e-8)
            if (abs(loss.value) < target_loss):
                res += iteration
                reached_target = True
                break
        assert reached_target, "Loss not reached"
    return res / runs

#run_learning3(0.75, 0.007)