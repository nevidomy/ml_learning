import torch
import torch.nn.functional as F

torch.set_printoptions(
    precision=3,      # digits after decimal
    sci_mode=False,   # disable scientific notation
    linewidth=200,    # output width
    threshold=100,   # summarize tensors larger than this
)

def name_to_tensor(name):
    return torch.tensor([0]+[1 + ord(c) - ord("a") for c in name]+[0])
def tensor_to_name(tensor):
    return "".join([chr(c + ord("a")-1) for c in tensor[1:-1]])


W = torch.load("weights.pt", weights_only=True, map_location="cpu")

def goForward(a):
    return (F.one_hot(torch.tensor(a), num_classes=27).float() @ W).softmax(0)

def sample_word():
    res = [0]
    a = 0
    while True:
        b = goForward(a).multinomial(num_samples=1, replacement=True).item()
        res.append(b)
        if (b == 0):
            break
        a = b
    return tensor_to_name(torch.tensor(res))

def negLogLikelihood(word):
    t = name_to_tensor(word)
    log_prob = 0.0
    for i in range(len(t)-1):
        p = goForward(t[i])
        log_prob += torch.log(p[t[i+1]])
    return -log_prob/(len(t) - 1)

def average_negLogLikelihood(words):
    return sum(negLogLikelihood(word) for word in words) / len(words)
    
NAMES = [name.strip() for name in open("names.txt", "r").readlines()]

for i in range(10):
    print(sample_word())

print(average_negLogLikelihood(NAMES))