import os
from micrograd.vgrad import Var

import random
import torch
import torch.nn as nn
import torch.optim as optim

import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd().parent))

import matplotlib.pyplot as plt
import seaborn as sns

from micrograd import vnet, vgrad

torch.set_printoptions(
    precision=3,      # digits after decimal
    sci_mode=False,   # disable scientific notation
    linewidth=120,    # output width
    threshold=100,   # summarize tensors larger than this
)

# Set up

NAMES = [name.strip() for name in open("names.txt", "r").readlines()]

def name_to_tensor(name):
    return torch.tensor([0]+[1 + ord(c) - ord("a") for c in name]+[0])
def tensor_to_name(tensor):
    return "".join([chr(c + ord("a")-1) for c in tensor[1:-1]])


def save_parameters(NN):
    with open("parameters.txt", "w") as f:
        for param in NN.parameters():
            f.write(f"{param.value}\n")

def load_parameters(NN):
    with open("parameters.txt", "r") as f:
        for param in NN.parameters():
            param.value = float(f.readline())


def token(c):
    if c == 0: return 0.0
    if c <= 13: return -c/14.0 
    return (c-13)/14.0

def do_batch(NN, names, momentum_decay=0.75, learning_rate=0.007, times=10):
    velocity = [0.0 for _ in NN.parameters()]
    vsq = [0.0 for _ in NN.parameters()]

    print("Params: ",len(NN.parameters()))

    for _ in range(times):
        losses = []
        for name in names:
            word = name_to_tensor(name)
            tokens = [0] * 15
            for i in range(1,len(word)):
                losses.append(
                    Var.crossEntropyLoss(NN([Var(t) for t in tokens]), word[i]))
                tokens[i-1] = token(word[i])
        loss = Var.sum(losses) * Var(1.0/len(losses))
        print("Loss: ", loss.value)
        NN.zero_grad()
        loss.backward()
        for i, param in enumerate(NN.parameters()):
                velocity[i] = velocity[i] * momentum_decay + param.grad
                vsq[i] = vsq[i] * 0.999 + 0.001 * param.grad**2
                param.value -= learning_rate * velocity[i] / (vsq[i]**0.5 + 1e-8)

NN = vnet.NNetwork([15, 24, 27], lastLayerActivationFunction='none')

if os.path.exists("parameters.txt"):
    load_parameters(NN)

n = len(NAMES)

while True:
    x = random.randint(0, (n // 100)-1) * 100
    do_batch(NN, NAMES[x:x+100])
    save_parameters(NN)
    print("Checkpoint saved")